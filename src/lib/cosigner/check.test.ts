import { beforeEach, describe, expect, it, vi } from "vitest";
import { LOVELACE } from "@/lib/assets";
import type { BudgetSources } from "@/lib/db/budgetSetups";
import type { CitedProposalRow, PayoutForCheck } from "@/lib/db/cosigner";
import type { PaymentRow, TransactionRow, TreasuryRow } from "@/lib/db/types";
import { CosignerKind, ExecutionState, ProposalState, SpendingPath, TreasuryTemplate, TxKind, TxState } from "@/lib/constants";

const mocks = vi.hoisted(() => ({
  hash: vi.fn(),
  outputs: vi.fn(), mint: vi.fn(), extract: vi.fn(),
  compare: vi.fn(),
  payouts: vi.fn(), payments: vi.fn(), mints: vi.fn(), proposals: vi.fn(),
  settings: vi.fn(), communitySettings: vi.fn(),
  siblings: vi.fn(),
  spent: vi.fn(),
  registry: vi.fn(),
  setupsTreasury: vi.fn(), setupsWorkgroups: vi.fn(), sources: vi.fn(),
}));
vi.mock("@meshsdk/core-cst", () => ({ resolveTxHash: mocks.hash }));
vi.mock("@/lib/cardano/cborMetadata", () => ({
  decodeTxOutputs: mocks.outputs, decodeTxMint: mocks.mint, extractPayoutMetadata: mocks.extract,
}));
vi.mock("@/lib/cosigner/compare", () => ({ compareTxToRows: mocks.compare }));
vi.mock("@/lib/db/cosigner", () => ({
  loadPayoutsForCheck: mocks.payouts, loadPaymentsForTx: mocks.payments, loadMintsForTx: mocks.mints, loadProposalsByNumbers: mocks.proposals,
}));
vi.mock("@/lib/db/governance", () => ({
  loadGovernanceSettings: mocks.settings, loadGovernanceCommunitySettings: mocks.communitySettings,
}));
vi.mock("@/lib/db/payments", () => ({ loadSiblingTreasuries: mocks.siblings }));
vi.mock("@/lib/db/spendCheck", () => ({ loadSpentForTargets: mocks.spent }));
vi.mock("@/lib/db/assets", () => ({ loadAssetRegistry: mocks.registry }));
vi.mock("@/lib/db/budgetSetups", () => ({
  loadBudgetSetupsForTreasury: mocks.setupsTreasury, loadBudgetSetupsForWorkgroups: mocks.setupsWorkgroups, loadBudgetSources: mocks.sources,
}));

import { runCosignerCheck } from "./check";

const TX_HASH = "a".repeat(64);
const CBOR = "84a0";
const WG = "11111111-1111-4111-8111-111111111111";
const WG_KEY = `w:${WG}`;
const TREASURY_KEY = "t:t-1";
const ALICE = "addr_test1alice";
const BOB = "addr_test1bob";
const SIBLING = "addr_test1sibling";
const H1 = "b".repeat(64);
const H2 = "c".repeat(64);

const TREASURY: TreasuryRow = {
  id: "t-1", community_id: "c-1", name: "Main", network: 0, required: 2, script_type: "atLeast",
  address: "addr_test1treasury", script_cbor: "8200", stake_credential_hash: null,
  template: TreasuryTemplate.Cosigner, lock_slot: null, lock_until: null,
  recovery_script_type: null, recovery_required: null, cosigner_kind: CosignerKind.App,
  archived_at: null, archived_by: null,
};

function tx(patch: Partial<TransactionRow> = {}): TransactionRow {
  return {
    id: "tx-1", treasury_id: "t-1", kind: TxKind.Payout, tx_cbor: CBOR, tx_hash: TX_HASH, description: null,
    signed_addresses: [ALICE], rejected_addresses: [], state: TxState.Pending, created_by: ALICE,
    submitted_at: null, created_at: "2026-10-01T00:00:00Z", discord_notified_at: null, spend_problems: [],
    block_time: null, spending_path: SpendingPath.Cosigned, governance_action: null, ...patch,
  };
}

function payout(patch: Partial<PayoutForCheck> = {}): PayoutForCheck {
  return {
    task_id: "task-7", contributor_wallet: ALICE, unit: LOVELACE, amount: "5000000",
    tasks: { number: 7, workgroup_id: WG, budget_month: "2026-10-01", workgroups: { name: "Dev" } },
    ...patch,
  };
}

function payment(patch: Partial<PaymentRow> = {}): PaymentRow {
  return {
    id: "pm-1", transaction_id: "tx-1", community_id: "c-1", treasury_id: "t-1", recipient_wallet: BOB,
    recipient_treasury_id: null, label: null, unit: LOVELACE, amount: "2000000", budget_month: "2026-10-01",
    created_at: "2026-10-01T00:00:00Z", ...patch,
  };
}

/** A recurring monthly budget of 10 ADA for the owner, set by proposal p-1. */
function sources(ownerKey: string, patch: { amount?: string; proposal_id?: string | null } = {}): BudgetSources {
  return {
    setups: new Map([[ownerKey, [{
      id: "s-1", owner_key: ownerKey, starts_on: "2026-01-01", mode: "recurring", cadence: "monthly",
      amounts: [{ unit: LOVELACE, amount: patch.amount ?? "10000000", asset_label: "ADA", decimals: 6 }],
      proposal_id: patch.proposal_id === undefined ? "p-1" : patch.proposal_id,
    }]]]),
    plans: [],
  };
}

const proposal = (patch: Partial<CitedProposalRow> = {}): CitedProposalRow => ({
  number: 1, content_hash: H1, state: ProposalState.Passed, execution_state: ExecutionState.Applied, ...patch,
});

const CHANGE = { address: TREASURY.address, lovelace: "90000000", assets: [] };
const ALICE_OUT = { address: ALICE, lovelace: "5000000", assets: [] };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.hash.mockReturnValue(TX_HASH);
  mocks.outputs.mockReturnValue([ALICE_OUT, CHANGE]);
  mocks.mint.mockReturnValue([]);
  mocks.extract.mockReturnValue({ v: 3, src: "treasury-guild" });
  mocks.compare.mockReturnValue([]);
  mocks.payouts.mockResolvedValue([payout()]);
  mocks.payments.mockResolvedValue([payment()]);
  mocks.mints.mockResolvedValue([]);
  mocks.proposals.mockResolvedValue([]);
  mocks.settings.mockResolvedValue({ enabled: false });
  mocks.communitySettings.mockResolvedValue({ spendCheck: "warn" });
  mocks.siblings.mockResolvedValue([{ id: "t-2", name: "Ops", address: SIBLING }]);
  mocks.spent.mockResolvedValue([]);
  mocks.registry.mockResolvedValue([]);
  mocks.setupsTreasury.mockResolvedValue([{ starts_on: "2026-01-01", cadence: "monthly" }]);
  mocks.setupsWorkgroups.mockResolvedValue(new Map([[WG, [{ starts_on: "2026-01-01", cadence: "monthly" }]]]));
  mocks.sources.mockResolvedValue(sources(WG_KEY));
});

describe("runCosignerCheck: the transaction bytes", () => {
  it("refuses a transaction whose stored hash is not the hash of its bytes, and reads nothing else", async () => {
    mocks.hash.mockReturnValue("f".repeat(64));
    expect(await runCosignerCheck(tx(), TREASURY)).toEqual({
      passed: false, problems: ["The stored transaction hash does not match the transaction bytes"],
    });
    expect(mocks.hash).toHaveBeenCalledExactlyOnceWith(CBOR);
    for (const m of [mocks.outputs, mocks.mint, mocks.extract, mocks.compare, mocks.payouts, mocks.payments, mocks.mints, mocks.siblings, mocks.settings, mocks.spent, mocks.proposals]) {
      expect(m).not.toHaveBeenCalled();
    }
  });

  it("refuses bytes that cannot be hashed at all", async () => {
    mocks.hash.mockImplementation(() => { throw new Error("bad cbor"); });
    expect(await runCosignerCheck(tx(), TREASURY)).toEqual({ passed: false, problems: ["The transaction bytes cannot be read"] });
    expect(mocks.compare).not.toHaveBeenCalled();
  });
});

describe("runCosignerCheck: step 1, the stored rows", () => {
  it("passes with no problems when every step agrees", async () => {
    const result = await runCosignerCheck(tx(), TREASURY);
    expect(result).toEqual({ passed: true, problems: [] });
  });

  it("surfaces what compareTxToRows finds", async () => {
    mocks.compare.mockReturnValue(["Output 0 to addr_test1alice does not carry what the stored rows say"]);
    expect(await runCosignerCheck(tx(), TREASURY)).toEqual({
      passed: false, problems: ["Output 0 to addr_test1alice does not carry what the stored rows say"],
    });
  });

  it("hands a payout its payouts rows, the decoded outputs, mint, record and the sibling addresses", async () => {
    const meta = { v: 3, src: "treasury-guild", p: [[0, [[7, 0, 0, ["5"]]]]] };
    mocks.extract.mockReturnValue(meta);
    await runCosignerCheck(tx(), TREASURY);
    expect(mocks.payouts).toHaveBeenCalledExactlyOnceWith("tx-1");
    expect(mocks.payments).not.toHaveBeenCalled();
    expect(mocks.mints).not.toHaveBeenCalled();
    expect(mocks.siblings).toHaveBeenCalledExactlyOnceWith("c-1", "t-1");
    expect(mocks.compare).toHaveBeenCalledExactlyOnceWith({
      kind: TxKind.Payout,
      treasuryAddress: TREASURY.address,
      siblingAddresses: new Set([SIBLING]),
      outputs: [ALICE_OUT, CHANGE],
      mint: [],
      payoutMeta: meta,
      payouts: [{ taskNumber: 7, contributorWallet: ALICE, unit: LOVELACE, amount: "5000000" }],
      payments: [],
      mints: [],
    });
  });

  it("compares a transfer-only payment's outputs and charges no budget line", async () => {
    mocks.settings.mockResolvedValue({ enabled: true });
    mocks.payments.mockResolvedValue([payment({ recipient_wallet: SIBLING, recipient_treasury_id: "t-2", budget_month: null, amount: "9000000" })]);
    mocks.outputs.mockReturnValue([{ address: SIBLING, lovelace: "9000000", assets: [] }, CHANGE]);
    const result = await runCosignerCheck(tx({ kind: TxKind.Payment }), TREASURY);
    expect(result).toEqual({ passed: true, problems: [] });
    expect(mocks.payouts).not.toHaveBeenCalled();
    expect(mocks.compare).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      kind: TxKind.Payment,
      payments: [{ recipientWallet: SIBLING, recipientTreasuryId: "t-2", unit: LOVELACE, amount: "9000000" }],
      payouts: [],
    }));
    // A transfer is no spend: nothing to budget, nothing already spent to read.
    expect(mocks.sources).not.toHaveBeenCalled();
    expect(mocks.spent).not.toHaveBeenCalled();
  });

  it("checks an anchor's outputs (change only) and loads no rows, no budget and no citations", async () => {
    mocks.settings.mockResolvedValue({ enabled: true });
    mocks.outputs.mockReturnValue([CHANGE]);
    expect(await runCosignerCheck(tx({ kind: TxKind.Anchor }), TREASURY)).toEqual({ passed: true, problems: [] });
    expect(mocks.compare).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      kind: TxKind.Anchor, outputs: [CHANGE], mint: [], payouts: [], payments: [], mints: [],
    }));
    expect(mocks.payouts).not.toHaveBeenCalled();
    expect(mocks.payments).not.toHaveBeenCalled();
    expect(mocks.mints).not.toHaveBeenCalled();
    expect(mocks.settings).not.toHaveBeenCalled();
    expect(mocks.spent).not.toHaveBeenCalled();
    expect(mocks.proposals).not.toHaveBeenCalled();
  });

  it("checks a CIP-0146 registration like an anchor (change only, no spend)", async () => {
    mocks.outputs.mockReturnValue([CHANGE]);
    expect(await runCosignerCheck(tx({ kind: TxKind.Registration }), TREASURY)).toEqual({ passed: true, problems: [] });
    expect(mocks.compare).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      kind: TxKind.Registration, outputs: [CHANGE], mint: [],
    }));
    expect(mocks.settings).not.toHaveBeenCalled();
  });

  it("hands a mint its forged assets and stored mints, and runs no budget check", async () => {
    mocks.settings.mockResolvedValue({ enabled: true });
    const policy = "q".repeat(56);
    const forged = [{ unit: `${policy}4e4654`, policyId: policy, assetNameHex: "4e4654", quantity: "1" }];
    mocks.mint.mockReturnValue(forged);
    mocks.mints.mockResolvedValue([{ policy_id: policy, asset_name_hex: "4e4654", quantity: "1", recipient: ALICE }]);
    mocks.extract.mockReturnValue({ v: 3, src: "treasury-guild", g: [[1, H1, [7]]] });
    await runCosignerCheck(tx({ kind: TxKind.Mint }), TREASURY);
    expect(mocks.mints).toHaveBeenCalledExactlyOnceWith("tx-1");
    expect(mocks.compare).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      kind: TxKind.Mint,
      mint: forged,
      mints: [{ policyId: policy, assetNameHex: "4e4654", quantity: "1", recipient: ALICE }],
    }));
    expect(mocks.settings).not.toHaveBeenCalled();
    expect(mocks.spent).not.toHaveBeenCalled();
    // Citations are a payout / payment matter; a mint's record is never read for them.
    expect(mocks.proposals).not.toHaveBeenCalled();
  });
});

describe("runCosignerCheck: step 2, the budget", () => {
  const twoAssignees = [payout(), payout({ contributor_wallet: BOB })];

  it("runs nothing while the community's budget kind is off", async () => {
    mocks.payouts.mockResolvedValue(twoAssignees);
    mocks.sources.mockResolvedValue({ setups: new Map(), plans: [] });
    expect(await runCosignerCheck(tx(), TREASURY)).toEqual({ passed: true, problems: [] });
    expect(mocks.settings).toHaveBeenCalledExactlyOnceWith("c-1", "budget");
    expect(mocks.sources).not.toHaveBeenCalled();
    expect(mocks.spent).not.toHaveBeenCalled();
  });

  it("charges a payout's task amount times its assignees to the workgroup's period, leaving this transaction's own rows out", async () => {
    mocks.settings.mockResolvedValue({ enabled: true });
    mocks.payouts.mockResolvedValue(twoAssignees);
    mocks.spent.mockResolvedValue([{ ownerKey: WG_KEY, periodMonth: "2026-10", unit: LOVELACE, amount: 5_000_000n }]);
    const result = await runCosignerCheck(tx(), TREASURY);
    expect(mocks.sources).toHaveBeenCalledExactlyOnceWith([WG_KEY]);
    expect(mocks.spent).toHaveBeenCalledExactlyOnceWith(
      "c-1",
      [{ ownerKey: WG_KEY, ownerType: "workgroup", ownerId: WG, periodMonth: "2026-10", cadence: "monthly" }],
      { excludeTransactionId: "tx-1" },
    );
    // 5 already spent + 2 × 5 in this transaction > the 10 budget.
    expect(result.passed).toBe(false);
    expect(result.problems).toEqual([expect.stringMatching(/^Dev would go over its 2026-10 budget of 10 ADA: 5 ADA already spent, 10 ADA in this transaction\.$/)]);
  });

  it("passes a spend that fits the voted budget exactly", async () => {
    mocks.settings.mockResolvedValue({ enabled: true });
    mocks.payouts.mockResolvedValue(twoAssignees);
    expect(await runCosignerCheck(tx(), TREASURY)).toEqual({ passed: true, problems: [] });
  });

  it("refuses on any problem regardless of the community's warn / refuse choice", async () => {
    mocks.settings.mockResolvedValue({ enabled: true });
    mocks.communitySettings.mockResolvedValue({ spendCheck: "warn" });
    mocks.sources.mockResolvedValue(sources(WG_KEY, { proposal_id: null }));
    const result = await runCosignerCheck(tx(), TREASURY);
    expect(result).toEqual({ passed: false, problems: ["The 2026-10 budget of Dev was set directly, not by a proposal."] });
    // The mode is the build routes' business; the co-signer never reads it.
    expect(mocks.communitySettings).not.toHaveBeenCalled();
  });

  it("refuses a spend with no budget in force, reading nothing spent for it", async () => {
    mocks.settings.mockResolvedValue({ enabled: true });
    mocks.sources.mockResolvedValue({ setups: new Map(), plans: [] });
    expect(await runCosignerCheck(tx(), TREASURY)).toEqual({ passed: false, problems: ["Dev has no budget for 2026-10."] });
    expect(mocks.spent).toHaveBeenCalledExactlyOnceWith("c-1", [], { excludeTransactionId: "tx-1" });
  });

  it("charges a manual payment's spend outputs to the treasury's budget and skips its transfers", async () => {
    mocks.settings.mockResolvedValue({ enabled: true });
    mocks.payments.mockResolvedValue([
      payment({ amount: "8000000" }),
      payment({ id: "pm-2", recipient_wallet: SIBLING, recipient_treasury_id: "t-2", budget_month: null, amount: "50000000" }),
    ]);
    mocks.sources.mockResolvedValue(sources(TREASURY_KEY));
    mocks.spent.mockResolvedValue([{ ownerKey: TREASURY_KEY, periodMonth: "2026-10", unit: LOVELACE, amount: 3_000_000n }]);
    const result = await runCosignerCheck(tx({ kind: TxKind.Payment }), TREASURY);
    expect(mocks.setupsTreasury).toHaveBeenCalledExactlyOnceWith("t-1");
    expect(mocks.sources).toHaveBeenCalledExactlyOnceWith([TREASURY_KEY]);
    expect(mocks.spent).toHaveBeenCalledExactlyOnceWith(
      "c-1",
      [{ ownerKey: TREASURY_KEY, ownerType: "treasury", ownerId: "t-1", periodMonth: "2026-10", cadence: "monthly" }],
      { excludeTransactionId: "tx-1" },
    );
    expect(result).toEqual({
      passed: false,
      problems: ["Treasury: Main would go over its 2026-10 budget of 10 ADA: 3 ADA already spent, 8 ADA in this transaction."],
    });
  });
});

describe("runCosignerCheck: step 3, the citations", () => {
  const cite = (...g: unknown[]) => mocks.extract.mockReturnValue({ v: 3, src: "treasury-guild", g });

  it("passes when every cited proposal passed, was applied and still has the cited content hash", async () => {
    cite([2, H2, [7]], [1, H1, [7]]);
    mocks.proposals.mockResolvedValue([proposal(), proposal({ number: 2, content_hash: H2 })]);
    expect(await runCosignerCheck(tx(), TREASURY)).toEqual({ passed: true, problems: [] });
    expect(mocks.proposals).toHaveBeenCalledExactlyOnceWith("c-1", [2, 1]);
  });

  it("reads no proposals when the record cites nothing", async () => {
    await runCosignerCheck(tx(), TREASURY);
    expect(mocks.proposals).not.toHaveBeenCalled();
  });

  it("refuses a citation of a proposal the community does not have", async () => {
    cite([1, H1, [7]], [2, H2, [7]]);
    mocks.proposals.mockResolvedValue([proposal()]);
    expect(await runCosignerCheck(tx(), TREASURY)).toEqual({
      passed: false, problems: ["Cited proposal #2 does not exist in this community"],
    });
  });

  it("refuses a cited proposal that did not pass", async () => {
    cite([1, H1, [7]]);
    mocks.proposals.mockResolvedValue([proposal({ state: ProposalState.Rejected })]);
    expect(await runCosignerCheck(tx(), TREASURY)).toEqual({ passed: false, problems: ["Cited proposal #1 did not pass"] });
  });

  it("refuses a cited proposal that passed but was not applied", async () => {
    cite([1, H1, [7]]);
    mocks.proposals.mockResolvedValue([proposal({ execution_state: ExecutionState.Failed })]);
    expect(await runCosignerCheck(tx(), TREASURY)).toEqual({ passed: false, problems: ["Cited proposal #1 was not applied"] });
  });

  it("refuses a cited proposal whose content hash is not the record's", async () => {
    cite([1, H2, [7]]);
    mocks.proposals.mockResolvedValue([proposal()]);
    expect(await runCosignerCheck(tx(), TREASURY)).toEqual({
      passed: false, problems: ["Cited proposal #1 has another content hash than the record"],
    });
  });

  it("checks citations even while the budget kind is off, and collects every step's problems", async () => {
    mocks.settings.mockResolvedValue({ enabled: false });
    mocks.compare.mockReturnValue(["The transaction carries no Treasury Guild payout record"]);
    cite([1, H1, [7]]);
    mocks.proposals.mockResolvedValue([]);
    expect(await runCosignerCheck(tx({ kind: TxKind.Payment }), TREASURY)).toEqual({
      passed: false,
      problems: [
        "The transaction carries no Treasury Guild payout record",
        "Cited proposal #1 does not exist in this community",
      ],
    });
  });

  it("ignores malformed citation entries", async () => {
    cite(["1", H1], [3], "junk");
    expect(await runCosignerCheck(tx(), TREASURY)).toEqual({ passed: true, problems: [] });
    expect(mocks.proposals).not.toHaveBeenCalled();
  });
});
