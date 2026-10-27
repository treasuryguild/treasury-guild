import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BudgetSources } from "@/lib/db/budgetSetups";
import { BadRequestError } from "@/lib/errors";
import { SpendCheckMode } from "./rules";
import { spendKey, spendProblemText, type SpentAmount } from "./spendCheck";

const mocks = vi.hoisted(() => ({ settings: vi.fn(), communitySettings: vi.fn(), spent: vi.fn() }));
vi.mock("@/lib/db/governance", () => ({
  loadGovernanceSettings: mocks.settings, loadGovernanceCommunitySettings: mocks.communitySettings,
}));
vi.mock("@/lib/db/spendCheck", () => ({ loadSpentForTargets: mocks.spent }));

import { budgetsForLines, guardSpend, SPEND_CHECK_FAILED, type SpendGuardLine } from "./spendGuard";

const WG = "11111111-1111-4111-8111-111111111111";
const WG_KEY = `w:${WG}`;
const OTHER = "22222222-2222-4222-8222-222222222222";
const OTHER_KEY = `w:${OTHER}`;
const ADA = { unit: "lovelace", ticker: "ADA", decimals: 6 };
const GVTT = { unit: `${"a".repeat(56)}47565454`, ticker: "GVTT", decimals: 0 };

function line(patch: Partial<SpendGuardLine> & Pick<SpendGuardLine, "amount">): SpendGuardLine {
  return { ownerKey: WG_KEY, ownerType: "workgroup", ownerId: WG, ownerName: "Dev", periodMonth: "2026-10", ...ADA, ...patch };
}

/** Dev: a recurring monthly budget of 100 ADA set by proposal p-1; nothing for anyone else. */
function sources(patch: { proposal_id?: string | null } = {}): BudgetSources {
  return {
    setups: new Map([[WG_KEY, [{
      id: "s-1", owner_key: WG_KEY, starts_on: "2026-01-01", mode: "recurring", cadence: "monthly",
      amounts: [{ unit: ADA.unit, amount: "100000000", asset_label: "ADA", decimals: 6 }],
      proposal_id: patch.proposal_id === undefined ? "p-1" : patch.proposal_id,
    }]]]),
    plans: [],
  };
}
const spent = (amount: bigint, unit = ADA.unit): SpentAmount => ({ ownerKey: WG_KEY, periodMonth: "2026-10", unit, amount });
const TARGET = { ownerKey: WG_KEY, ownerType: "workgroup", ownerId: WG, periodMonth: "2026-10", cadence: "monthly" };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.settings.mockResolvedValue({ enabled: true });
  mocks.communitySettings.mockResolvedValue({
    documentStore: null, documentStoreSince: null,
    documentArchiveRepoId: null, documentArchiveFullName: null, spendCheck: SpendCheckMode.Warn,
  });
  mocks.spent.mockResolvedValue([]);
});

describe("budgetsForLines", () => {
  it("resolves one budget per owner and period, null where nothing is budgeted", () => {
    const budgets = budgetsForLines([
      line({ amount: 1n }), line({ amount: 2n, ...GVTT }), line({ amount: 3n, periodMonth: "2026-11" }),
      line({ amount: 4n, ownerKey: OTHER_KEY, ownerId: OTHER, ownerName: "Ops" }),
    ], sources());
    expect([...budgets.keys()]).toEqual([spendKey(WG_KEY, "2026-10"), spendKey(WG_KEY, "2026-11"), spendKey(OTHER_KEY, "2026-10")]);
    expect(budgets.get(spendKey(WG_KEY, "2026-10"))).toMatchObject({ setupId: "s-1", periodMonth: "2026-10", cadence: "monthly", proposalId: "p-1" });
    expect(budgets.get(spendKey(WG_KEY, "2026-11"))).toMatchObject({ periodMonth: "2026-11" });
    expect(budgets.get(spendKey(OTHER_KEY, "2026-10"))).toBeNull();
  });
});

describe("guardSpend", () => {
  it("is a no-op without lines: a build of transfers only charges nobody and reads nothing", async () => {
    expect(await guardSpend("c-1", [], sources())).toEqual([]);
    expect(mocks.settings).not.toHaveBeenCalled();
    expect(mocks.spent).not.toHaveBeenCalled();
    expect(mocks.communitySettings).not.toHaveBeenCalled();
  });

  it("is a no-op while the community's budget kind is off", async () => {
    mocks.settings.mockResolvedValue({ enabled: false });
    expect(await guardSpend("c-1", [line({ amount: 500_000_000n })], sources())).toEqual([]);
    expect(mocks.settings).toHaveBeenCalledExactlyOnceWith("c-1", "budget");
    expect(mocks.spent).not.toHaveBeenCalled();
    expect(mocks.communitySettings).not.toHaveBeenCalled();
  });

  it("returns nothing when the spend fits", async () => {
    mocks.spent.mockResolvedValue([spent(40_000_000n)]);
    expect(await guardSpend("c-1", [line({ amount: 60_000_000n })], sources())).toEqual([]);
  });

  it("reads what is spent for the budgeted targets only, without excluding any transaction", async () => {
    await guardSpend("c-1", [
      line({ amount: 1n }), line({ amount: 2n, ...GVTT }),
      line({ amount: 3n, ownerKey: OTHER_KEY, ownerId: OTHER, ownerName: "Ops" }),
    ], sources());
    expect(mocks.spent).toHaveBeenCalledExactlyOnceWith("c-1", [TARGET]);
  });

  it("warn mode: returns the problems for the transaction row, as text through spendProblemText", async () => {
    mocks.spent.mockResolvedValue([spent(50_000_000n)]);
    const problems = await guardSpend("c-1", [
      line({ amount: 60_000_000n }), line({ amount: 7n, ...GVTT }),
      line({ amount: 3n, ownerKey: OTHER_KEY, ownerId: OTHER, ownerName: "Ops" }),
    ], sources());
    expect(problems).toEqual([
      {
        code: "over_budget", ownerKey: WG_KEY, ownerName: "Dev", period: "2026-10",
        unit: ADA.unit, ticker: "ADA", decimals: 6, amount: "60000000", budget: "100000000", spent: "50000000",
      },
      { code: "over_budget", ownerKey: WG_KEY, ownerName: "Dev", period: "2026-10", ...GVTT, amount: "7", budget: "0", spent: "0" },
      { code: "no_budget", ownerKey: OTHER_KEY, ownerName: "Ops", period: "2026-10" },
    ]);
    expect(problems.map(spendProblemText)).toEqual([
      "Dev would go over its 2026-10 budget of 100 ADA: 50 ADA already spent, 60 ADA in this transaction.",
      "Dev would go over its 2026-10 budget of 0 GVTT: 0 GVTT already spent, 7 GVTT in this transaction.",
      "Ops has no budget for 2026-10.",
    ]);
  });

  it("warn mode: reports a budget saved directly rather than voted", async () => {
    expect(await guardSpend("c-1", [line({ amount: 1n })], sources({ proposal_id: null }))).toEqual([
      { code: "budget_not_voted", ownerKey: WG_KEY, ownerName: "Dev", period: "2026-10" },
    ]);
  });

  it("refuse mode: throws the build error (400) naming every problem", async () => {
    mocks.communitySettings.mockResolvedValue({
      documentStore: null, documentStoreSince: null,
      documentArchiveRepoId: null, documentArchiveFullName: null, spendCheck: SpendCheckMode.Refuse,
    });
    mocks.spent.mockResolvedValue([spent(50_000_000n)]);
    const call = guardSpend("c-1", [
      line({ amount: 60_000_000n }), line({ amount: 3n, ownerKey: OTHER_KEY, ownerId: OTHER, ownerName: "Ops" }),
    ], sources());
    await expect(call).rejects.toThrow(BadRequestError);
    await expect(call).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(new RegExp(`^${SPEND_CHECK_FAILED}`)),
      extra: {
        problems: [
          "Dev would go over its 2026-10 budget of 100 ADA: 50 ADA already spent, 60 ADA in this transaction.",
          "Ops has no budget for 2026-10.",
        ],
      },
    });
  });

  it("refuse mode: lets a fitting spend through", async () => {
    mocks.communitySettings.mockResolvedValue({
      documentStore: null, documentStoreSince: null,
      documentArchiveRepoId: null, documentArchiveFullName: null, spendCheck: SpendCheckMode.Refuse,
    });
    expect(await guardSpend("c-1", [line({ amount: 100_000_000n })], sources())).toEqual([]);
  });
});
