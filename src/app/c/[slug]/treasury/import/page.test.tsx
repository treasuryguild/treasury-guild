// @vitest-environment jsdom
import { Suspense } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push, replace: mocks.replace }) }));
vi.mock("@/lib/api/client", () => ({ apiFetch: mocks.fetch, describeApiError: (e: Error) => e.message }));
vi.mock("@/hooks/useCommunityGate", () => ({
  useCommunityGate: () => ({ community: { id: "community", network: 0 }, blocked: null }),
}));
vi.mock("@/hooks/useNetworkGate", () => ({ useNetworkGate: () => ({ reason: null }) }));
vi.mock("@/hooks/useSession", () => ({ useSession: () => ({ sessionWallet: "addr_test1known" }) }));
vi.mock("@/hooks/useWorkgroups", () => ({ useWorkgroups: () => ({ data: [] }) }));
import ImportTreasury from "./page";

const preview = {
  address: "addr_test1treasury", scriptCbor: "820182",
  stakeCredentialHash: null, suggestedName: null,
  template: "plain", scriptType: "all", required: 2,
  recovery: null, lockSlot: null, lockUntil: null,
  signers: [
    { keyHash: "a".repeat(56), address: "addr_test1known", group: "base", name: "" },
    { keyHash: "b".repeat(56), address: "", group: "base", name: "" },
  ],
};

const incompleteDraft = {
  id: "draft-1",
  communityId: "community",
  name: "Existing treasury",
  workgroupId: null,
  expiresAt: "2026-11-13T00:00:00.000Z",
  scriptCbor: "820182",
  stakeCredentialHash: null,
  filled: 1,
  total: 2,
  signers: [
    { keyHash: "a".repeat(56), group: "base" as const, address: "addr_test1known", name: null, claimed: true },
    { keyHash: "b".repeat(56), group: "base" as const, address: null, name: null, claimed: false },
  ],
};

const completeDraft = {
  ...incompleteDraft,
  filled: 2,
  signers: [
    incompleteDraft.signers[0]!,
    { keyHash: "b".repeat(56), group: "base" as const, address: "addr_test1second", name: null, claimed: true },
  ],
};

beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

async function open() {
  await act(async () => {
    render(
      <Suspense>
        <ImportTreasury
          params={Promise.resolve({ slug: "guild" })}
          searchParams={Promise.resolve({})}
        />
      </Suspense>,
    );
  });
  return userEvent.setup();
}

describe("treasury import page", () => {
  it("reviews CBOR, invites signers, and imports once every key is claimed", async () => {
    mocks.fetch
      .mockResolvedValueOnce(preview)
      .mockResolvedValueOnce({ draft: incompleteDraft, url: "https://app.test/invite/import/tok" })
      .mockResolvedValueOnce({ draft: completeDraft })
      .mockResolvedValueOnce({ treasury: { id: "t1" }, link: null, linkError: null });
    const user = await open();
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Existing treasury");
    await user.type(screen.getByRole("textbox", { name: "Native script (CBOR hex)" }), "820182");
    await user.click(screen.getByRole("button", { name: "Read CBOR" }));
    expect(await screen.findByText("addr_test1treasury")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Save and invite" }));
    expect(await screen.findByDisplayValue("https://app.test/invite/import/tok")).toBeTruthy();
    expect(screen.getByText("Waiting")).toBeTruthy();
    const submit = screen.getByRole("button", { name: "Import treasury" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await user.type(screen.getByRole("textbox", { name: "Payment addresses" }), "addr_test1second");
    await user.click(screen.getByRole("button", { name: "Match addresses" }));
    expect(mocks.fetch).toHaveBeenCalledWith("/api/treasury/import-draft/slot", {
      body: {
        draftId: "draft-1",
        communityId: "community",
        addresses: ["addr_test1second"],
      },
    });
    await user.click(screen.getByRole("button", { name: "Import treasury" }));
    expect(mocks.fetch).toHaveBeenLastCalledWith("/api/treasury", {
      body: {
        communityId: "community",
        name: "Existing treasury",
        source: { type: "cbor", cbor: "820182" },
        importDraftId: "draft-1",
        workgroupId: null,
      },
    });
    expect(mocks.push).toHaveBeenCalledWith("/c/guild/treasury");
  });

  it("splits pasted payment addresses on newlines and commas", async () => {
    mocks.fetch
      .mockResolvedValueOnce(preview)
      .mockResolvedValueOnce({ draft: incompleteDraft, url: "https://app.test/invite/import/tok" })
      .mockResolvedValueOnce({ draft: completeDraft });
    const user = await open();
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Existing treasury");
    await user.type(screen.getByRole("textbox", { name: "Native script (CBOR hex)" }), "820182");
    await user.click(screen.getByRole("button", { name: "Read CBOR" }));
    await user.click(await screen.findByRole("button", { name: "Save and invite" }));
    expect(await screen.findByText("Waiting")).toBeTruthy();
    const paste = screen.getByRole("textbox", { name: "Payment addresses" });
    await user.click(paste);
    await user.paste("addr_test1second\naddr_test1known, addr_test1third");
    await user.click(screen.getByRole("button", { name: "Match addresses" }));
    expect(mocks.fetch).toHaveBeenCalledWith("/api/treasury/import-draft/slot", {
      body: {
        draftId: "draft-1",
        communityId: "community",
        addresses: ["addr_test1second", "addr_test1known", "addr_test1third"],
      },
    });
  });

  it("clears the reviewed address when CBOR changes", async () => {
    mocks.fetch.mockResolvedValue(preview);
    const user = await open();
    const cbor = screen.getByRole("textbox", { name: "Native script (CBOR hex)" });
    await user.type(cbor, "820182");
    await user.click(screen.getByRole("button", { name: "Read CBOR" }));
    expect(await screen.findByText("addr_test1treasury")).toBeTruthy();
    await user.type(cbor, "00");
    expect(screen.queryByText("addr_test1treasury")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save and invite" })).toBeNull();
  });

  it("shows a decoding error without enabling invite", async () => {
    mocks.fetch.mockRejectedValue(new Error("Invalid native-script CBOR"));
    const user = await open();
    await user.type(screen.getByRole("textbox", { name: "Native script (CBOR hex)" }), "00");
    await user.click(screen.getByRole("button", { name: "Read CBOR" }));
    expect(await screen.findByText("Invalid native-script CBOR")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save and invite" })).toBeNull();
  });
});
