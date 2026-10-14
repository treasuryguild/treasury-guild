import { beforeEach, describe, expect, it, vi } from "vitest";
import { BadRequestError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({ workgroups: vi.fn(), treasuries: vi.fn(), members: vi.fn(), appUrl: vi.fn() }));
vi.mock("@/lib/db/workgroups", () => ({ listCommunityWorkgroups: mocks.workgroups }));
vi.mock("@/lib/db/treasuries", () => ({ listCommunityTreasuries: mocks.treasuries }));
vi.mock("@/lib/db/membership", () => ({ listCommunityMembers: mocks.members }));
vi.mock("@/lib/db/communities", () => ({ requireCommunityBySlug: vi.fn() }));
vi.mock("@/lib/authz", () => ({ memberRole: vi.fn() }));
vi.mock("@/lib/env.server", () => ({ appUrl: mocks.appUrl }));

import {
  appLink, communityMemberRefs, memberName, requireMember, resolveCommunityTreasury, resolveCommunityWorkgroup,
} from "./shared";

const WG_ID = "50000000-0000-4000-8000-000000000001";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.workgroups.mockResolvedValue([{ id: WG_ID, name: "Dev" }, { id: "wg-2", name: "Ops" }]);
  mocks.treasuries.mockResolvedValue([{ id: "t-1", name: "Main" }, { id: "t-2", name: "Grants" }]);
});

describe("resolveCommunityWorkgroup / resolveCommunityTreasury", () => {
  it("finds by id or by name in any case", async () => {
    expect(await resolveCommunityWorkgroup("comm", WG_ID)).toMatchObject({ name: "Dev" });
    expect(await resolveCommunityWorkgroup("comm", "ops")).toMatchObject({ id: "wg-2" });
    expect(await resolveCommunityTreasury("comm", "t-2")).toMatchObject({ name: "Grants" });
    expect(await resolveCommunityTreasury("comm", "MAIN")).toMatchObject({ id: "t-1" });
    expect(mocks.workgroups).toHaveBeenCalledWith("comm");
    expect(mocks.treasuries).toHaveBeenCalledWith("comm");
  });

  it("answers 400 naming what exists, so a model can correct itself", async () => {
    await expect(resolveCommunityWorkgroup("comm", "Design")).rejects.toThrow(
      new BadRequestError('No workgroup "Design" in this community. Workgroups: Dev, Ops'),
    );
    await expect(resolveCommunityTreasury("comm", "Reserve")).rejects.toThrow(
      new BadRequestError('No treasury "Reserve" in this community. Treasuries: Main, Grants'),
    );
    mocks.treasuries.mockResolvedValue([]);
    await expect(resolveCommunityTreasury("comm", "Main")).rejects.toThrow("Treasuries: none");
  });
});

describe("members", () => {
  const ann = { wallet: "addr_test1ann", handle: "ann", githubUsername: "ann-gh" };
  const ann2 = { wallet: "addr_test1ann2", handle: "Ann", githubUsername: null };
  const bob = { wallet: "addr_test1bob", handle: null, githubUsername: "bob-gh" };

  it("maps memberships to refs with the profile's handle and GitHub login", async () => {
    mocks.members.mockResolvedValue([
      { wallet_address: "addr_test1ann", role: "admin", contributors: { handle: "ann", github_username: "ann-gh" } },
      { wallet_address: "addr_test1zed", role: "member", contributors: null },
    ]);
    expect(await communityMemberRefs("comm")).toEqual([
      { wallet: "addr_test1ann", role: "admin", handle: "ann", githubUsername: "ann-gh" },
      { wallet: "addr_test1zed", role: "member", handle: null, githubUsername: null },
    ]);
  });

  it("requires exactly one match, listing the candidates when several match", () => {
    expect(requireMember("bob-gh", [ann, bob])).toBe(bob);
    expect(() => requireMember("carol", [ann, bob])).toThrow('No member "carol" in this community');
    expect(() => requireMember("ann", [ann, ann2, bob])).toThrow(
      `"ann" matches 2 members: ${memberName(ann)} (addr_test1ann), ${memberName(ann2)} (addr_test1ann2). Use one of their wallets.`,
    );
  });
});

describe("appLink", () => {
  it("joins the app URL and the path with exactly one slash", () => {
    mocks.appUrl.mockReturnValue("https://vault.example/");
    expect(appLink("/c/guild/tx/1")).toBe("https://vault.example/c/guild/tx/1");
    mocks.appUrl.mockReturnValue("https://vault.example");
    expect(appLink("/c/guild")).toBe("https://vault.example/c/guild");
  });
});
