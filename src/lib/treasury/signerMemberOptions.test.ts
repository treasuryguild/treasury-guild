import { describe, expect, it } from "vitest";
import type { MemberWithContributor } from "@/lib/db/types";
import { signerMemberGroups, signerMemberOptions } from "./signerMemberOptions";

const member = (
  wallet: string,
  role: string,
  handle: string | null = null,
): MemberWithContributor => ({
  wallet_address: wallet,
  role,
  contributors: handle ? { handle, github_username: null } : null,
});

describe("signerMemberOptions", () => {
  it("groups admins, then leads, then members, and skips excluded wallets", () => {
    const options = signerMemberOptions(
      [
        member("addr_m", "member", "Mo"),
        member("addr_a", "admin", "Ann"),
        member("addr_o", "owner", "Oz"),
        member("addr_l", "member", "Lee"),
        member("addr_x", "member", "Skip"),
      ],
      new Set(["addr_l", "addr_a"]),
      new Set(["addr_x"]),
    );
    expect(options.map((o) => [o.group, o.wallet, o.name])).toEqual([
      ["admins", "addr_a", "Ann"],
      ["admins", "addr_o", "Oz"],
      ["leads", "addr_l", "Lee"],
      ["members", "addr_m", "Mo"],
    ]);
  });

  it("builds optgroups only for non-empty buckets", () => {
    const options = signerMemberOptions(
      [member("addr_a", "admin", "Ann")],
      new Set(),
    );
    expect(signerMemberGroups(options)).toEqual([
      {
        group: "admins",
        label: "Admins",
        options: [expect.objectContaining({ wallet: "addr_a" })],
      },
    ]);
  });
});
