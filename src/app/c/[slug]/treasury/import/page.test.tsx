// @vitest-environment jsdom
import { Suspense } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/lib/api/client", () => ({ apiFetch: mocks.fetch, describeApiError: (e: Error) => e.message }));
vi.mock("@/hooks/useCommunityGate", () => ({
  useCommunityGate: () => ({ community: { id: "community", network: 0 }, blocked: null }),
}));
vi.mock("@/hooks/useNetworkGate", () => ({ useNetworkGate: () => ({ reason: null }) }));
vi.mock("@/hooks/useWorkgroups", () => ({ useWorkgroups: () => ({ data: [] }) }));
import ImportTreasury from "./page";

const preview = {
  address: "addr_test1treasury", scriptCbor: "820182", template: "plain", scriptType: "all", required: 2,
  recovery: null, lockSlot: null, lockUntil: null,
  signers: [{ keyHash: "a".repeat(56), address: "addr_test1known", group: "base" }, { keyHash: "b".repeat(56), address: "", group: "base" }],
};
beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

async function open() {
  await act(async () => {
    render(<Suspense><ImportTreasury params={Promise.resolve({ slug: "guild" })} /></Suspense>);
  });
  return userEvent.setup();
}

describe("treasury import page", () => {
  it("reviews CBOR, requires missing signer addresses, and imports the reviewed script", async () => {
    mocks.fetch.mockResolvedValueOnce(preview).mockResolvedValueOnce({ treasury: { id: "t1" }, link: null, linkError: null });
    const user = await open();
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Existing treasury");
    await user.type(screen.getByRole("textbox", { name: "Native script (CBOR hex)" }), "820182");
    await user.click(screen.getByRole("button", { name: "Read CBOR" }));
    expect(await screen.findByText("addr_test1treasury")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Signer 1 address" }) as HTMLInputElement).value).toBe("addr_test1known");
    const submit = screen.getByRole("button", { name: "Import treasury" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await user.type(screen.getByRole("textbox", { name: "Signer 2 address" }), "addr_test1second");
    await user.click(submit);
    expect(mocks.fetch).toHaveBeenLastCalledWith("/api/treasury", { body: {
      communityId: "community", name: "Existing treasury", source: { type: "cbor", cbor: preview.scriptCbor },
      signers: [{ address: "addr_test1known", name: "" }, { address: "addr_test1second", name: "" }], workgroupId: null,
    } });
    expect(mocks.push).toHaveBeenCalledWith("/c/guild/treasury");
  });

  it("clears the reviewed address and signers when CBOR changes", async () => {
    mocks.fetch.mockResolvedValue(preview);
    const user = await open();
    const cbor = screen.getByRole("textbox", { name: "Native script (CBOR hex)" });
    await user.type(cbor, "820182");
    await user.click(screen.getByRole("button", { name: "Read CBOR" }));
    expect(await screen.findByText("addr_test1treasury")).toBeTruthy();
    await user.type(cbor, "00");
    expect(screen.queryByText("addr_test1treasury")).toBeNull();
    expect(screen.queryByRole("button", { name: "Import treasury" })).toBeNull();
  });

  it("shows a decoding error without enabling import", async () => {
    mocks.fetch.mockRejectedValue(new Error("Invalid native-script CBOR"));
    const user = await open();
    await user.type(screen.getByRole("textbox", { name: "Native script (CBOR hex)" }), "00");
    await user.click(screen.getByRole("button", { name: "Read CBOR" }));
    expect(await screen.findByText("Invalid native-script CBOR")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Import treasury" })).toBeNull();
  });
});
