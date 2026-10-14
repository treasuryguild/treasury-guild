import { describe, expect, it, vi } from "vitest";

vi.mock("./db/client", () => ({ maybe: vi.fn(), serviceClient: vi.fn() }));
vi.mock("./db/communities", () => ({ communitySlug: vi.fn() }));
vi.mock("./db/treasuries", () => ({ loadTreasury: vi.fn(), loadTreasurySigners: vi.fn() }));
vi.mock("./authz", async (original) => ({ ...(await original<typeof Authz>()), requireMember: vi.fn() }));

import type { UnitDisplay } from "./assetRegistry";
import type * as Authz from "./authz";
import { MSG, SignerGroup, type Role } from "./constants";
import type { TreasuryRow, TreasurySignerRow } from "./db/types";
import { BadRequestError, ForbiddenError } from "./errors";
import {
  builtTickers, builtTxResponse, requirePathBuilder, requireSigner, resolveSpendingPath, validFromSlotFor,
  type BuildContext, type BuiltTreasuryTx, type TxContext,
} from "./tx";

const HOSKY = `${"a".repeat(56)}484f534b59`;
const AGIX = `${"b".repeat(56)}41474958`;
const UNKNOWN = `${"c".repeat(56)}00`;

const display: UnitDisplay = new Map([
  ["lovelace", { ticker: "ADA", decimals: 6 }],
  [HOSKY, { ticker: "HOSKY", decimals: 0 }],
  [AGIX, { ticker: "AGIX", decimals: 8 }],
]);

const built = (totals: [string, bigint][], outputs: BuiltTreasuryTx["outputs"] = []): BuiltTreasuryTx => ({
  txHash: "f".repeat(64),
  totalByUnit: new Map(totals),
  outputs,
});

describe("builtTickers", () => {
  it("names each unit by its ticker, in first-seen order", () => {
    expect(builtTickers(built([[HOSKY, 5n], ["lovelace", 2_000_000n], [AGIX, 1n]]), display)).toEqual(["HOSKY", "ADA", "AGIX"]);
  });

  it("falls back to a shortened unit for a token the registry does not know", () => {
    expect(builtTickers(built([["lovelace", 1n], [UNKNOWN, 1n]]), display)).toEqual(["ADA", `${"c".repeat(12)}…`]);
  });

  it("lists a ticker once when two units share it", () => {
    const twin = `${"d".repeat(56)}484f534b59`;
    const shared: UnitDisplay = new Map([...display, [twin, { ticker: "HOSKY", decimals: 0 }]]);
    expect(builtTickers(built([[HOSKY, 1n], [twin, 1n], ["lovelace", 1n]]), shared)).toEqual(["HOSKY", "ADA"]);
  });

  it("is empty for a tx that moves nothing", () => {
    expect(builtTickers(built([]), display)).toEqual([]);
  });
});

describe("builtTxResponse", () => {
  it("answers with the row id, the hash and string quantities", () => {
    const tx = built(
      [["lovelace", 3_500_000n], [HOSKY, 10n]],
      [
        { address: "addr_test1alice", assets: [{ unit: "lovelace", quantity: 2_000_000n }, { unit: HOSKY, quantity: 10n }] },
        { address: "addr_test1bob", assets: [{ unit: "lovelace", quantity: 1_500_000n }] },
      ],
    );
    expect(builtTxResponse("tx-1", tx)).toEqual({
      txId: "tx-1",
      txHash: "f".repeat(64),
      totalByUnit: { lovelace: "3500000", [HOSKY]: "10" },
      outputs: [
        { address: "addr_test1alice", assets: [{ unit: "lovelace", quantity: "2000000" }, { unit: HOSKY, quantity: "10" }] },
        { address: "addr_test1bob", assets: [{ unit: "lovelace", quantity: "1500000" }] },
      ],
    });
  });

  it("keeps quantities beyond the float-safe range exact", () => {
    const huge = 45_000_000_000_000_001n;
    const res = builtTxResponse("tx-2", built([[HOSKY, huge]], [{ address: "a", assets: [{ unit: HOSKY, quantity: huge }] }]));
    expect(res.totalByUnit[HOSKY]).toBe("45000000000000001");
    expect(res.outputs[0]?.assets[0]?.quantity).toBe("45000000000000001");
  });

  it("is JSON-serializable (no bigint left)", () => {
    const res = builtTxResponse("tx-3", built([["lovelace", 1n]], [{ address: "a", assets: [{ unit: "lovelace", quantity: 1n }] }]));
    expect(() => JSON.stringify(res)).not.toThrow();
  });

  it("handles a tx without outputs", () => {
    expect(builtTxResponse("tx-4", built([]))).toEqual({ txId: "tx-4", txHash: "f".repeat(64), totalByUnit: {}, outputs: [] });
  });
});

describe("requireSigner", () => {
  const signer = { wallet_address: "addr_test1signer" } as TreasurySignerRow;
  const ctx = (callerSigner: TreasurySignerRow | null) => ({ callerSigner, signers: [signer] }) as TxContext;

  it("returns the caller's signer row", () => {
    expect(requireSigner(ctx(signer))).toBe(signer);
  });

  it("refuses a member who is not a signer, even when the treasury has signers", () => {
    expect(() => requireSigner(ctx(null))).toThrow(ForbiddenError);
    expect(() => requireSigner(ctx(null))).toThrow("Caller is not a signer of this treasury");
  });
});

describe("spending paths of a build", () => {
  const NOW = Date.parse("2026-10-01T00:00:00Z");
  const before = "2026-11-01T00:00:00Z";
  const after = "2026-09-01T00:00:00Z";
  const treasury = (over: Partial<TreasuryRow>) => ({ template: "plain", lock_until: null, lock_slot: null, ...over }) as TreasuryRow;
  const ctx = (over: Partial<TreasuryRow>, role: Role = "member", groups: SignerGroup[] = []) => ({
    treasury: treasury(over),
    role,
    isSigner: groups.includes(SignerGroup.Base),
    callerGroups: new Set(groups),
  }) as BuildContext;

  describe("resolveSpendingPath", () => {
    it("takes the template's default when none is requested", () => {
      expect(resolveSpendingPath(ctx({}), undefined, "payout", NOW)).toBe("base");
      expect(resolveSpendingPath(ctx({ template: "cosigner" }), undefined, "payout", NOW)).toBe("cosigned");
      expect(resolveSpendingPath(ctx({ template: "cosigner" }), "bypass", "payment", NOW)).toBe("bypass");
    });

    it("refuses a path the template lacks", () => {
      expect(() => resolveSpendingPath(ctx({}), "recovery", "payment", NOW)).toThrow(new BadRequestError(MSG.pathNotOffered));
      expect(() => resolveSpendingPath(ctx({ template: "cosigner" }), "base", "payment", NOW)).toThrow(BadRequestError);
    });

    it("builds nothing from a lock-until treasury before its date", () => {
      expect(() => resolveSpendingPath(ctx({ template: "lock_until", lock_until: before }), undefined, "payout", NOW)).toThrow(BadRequestError);
      expect(resolveSpendingPath(ctx({ template: "lock_until", lock_until: after }), undefined, "payout", NOW)).toBe("base");
    });

    it("offers recovery from the date, for payments only", () => {
      expect(() => resolveSpendingPath(ctx({ template: "clawback", lock_until: before }), "recovery", "payment", NOW)).toThrow(BadRequestError);
      const open = ctx({ template: "clawback", lock_until: after });
      expect(resolveSpendingPath(open, "recovery", "payment", NOW)).toBe("recovery");
      expect(() => resolveSpendingPath(open, "recovery", "payout", NOW)).toThrow(new BadRequestError(MSG.recoveryPaymentsOnly));
      expect(() => resolveSpendingPath(open, "recovery", "mint", NOW)).toThrow(BadRequestError);
    });
  });

  describe("requirePathBuilder", () => {
    const build = (path: Parameters<typeof requirePathBuilder>[1], role: Role, groups: SignerGroup[] = []) =>
      () => requirePathBuilder(ctx({ template: "clawback" }, role, groups), path, "Only admins or signers can build");

    it("lets admins and base signers build on every path but recovery", () => {
      expect(build("base", "admin")).not.toThrow();
      expect(build("base", "owner")).not.toThrow();
      expect(build("base", "member", [SignerGroup.Base])).not.toThrow();
      expect(build("cosigned", "member", [SignerGroup.Base])).not.toThrow();
      expect(build("bypass", "member", [SignerGroup.Base])).not.toThrow();
    });

    it("refuses members, recovery signers and a co-signer there, with the route's message", () => {
      expect(build("base", "member")).toThrow(new ForbiddenError("Only admins or signers can build"));
      expect(build("base", "member", [SignerGroup.Recovery])).toThrow(ForbiddenError);
      expect(build("cosigned", "member", [SignerGroup.Cosigner])).toThrow(ForbiddenError);
    });

    it("lets admins and recovery signers, not base signers, build on the recovery path", () => {
      expect(build("recovery", "admin")).not.toThrow();
      expect(build("recovery", "member", [SignerGroup.Recovery])).not.toThrow();
      expect(build("recovery", "member", [SignerGroup.Base])).toThrow("Only admins or recovery signers can build on the recovery path");
      expect(build("recovery", "member")).toThrow(ForbiddenError);
    });
  });

  describe("validFromSlotFor", () => {
    it("is the lock slot of a lock-until treasury on its only path", () => {
      expect(validFromSlotFor(treasury({ template: "lock_until", lock_slot: 123456789 }), "base")).toBe(123456789);
    });

    it("is the lock slot of a clawback treasury on the recovery path only", () => {
      const clawback = treasury({ template: "clawback", lock_slot: 42 });
      expect(validFromSlotFor(clawback, "recovery")).toBe(42);
      expect(validFromSlotFor(clawback, "base")).toBeNull();
    });

    it("is null for the templates without a lock", () => {
      expect(validFromSlotFor(treasury({}), "base")).toBeNull();
      expect(validFromSlotFor(treasury({ template: "cosigner" }), "cosigned")).toBeNull();
      expect(validFromSlotFor(treasury({ template: "cosigner" }), "bypass")).toBeNull();
    });
  });
});
