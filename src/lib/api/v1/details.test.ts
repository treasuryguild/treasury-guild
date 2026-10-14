// The detail reads: transaction_detail, funding_summary, call_list, proposal_detail.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiCaller } from "@/lib/api/caller";
import { CALL_ATTENDEE_COLUMNS } from "@/lib/db/types";
import { BadRequestError, NotFoundError } from "@/lib/errors";
import { DEFAULT_SETTINGS, rulesFor } from "@/lib/governance/rules";

const mocks = vi.hoisted(() => ({
  community: vi.fn(),
  role: vi.fn(),
  treasuries: vi.fn(),
  findTx: vi.fn(),
  txDetail: vi.fn(),
  registry: vi.fn(),
  labels: vi.fn(),
  decode: vi.fn(),
  funding: vi.fn(),
  calls: vi.fn(),
  numberMap: vi.fn(),
  editable: vi.fn(),
  listing: vi.fn(),
  events: vi.fn(),
  ballots: vi.fn(),
  tally: vi.fn(),
  copies: vi.fn(),
}));
vi.mock("@/lib/db/communities", () => ({ requireCommunityBySlug: mocks.community }));
vi.mock("@/lib/authz", () => ({ memberRole: mocks.role }));
vi.mock("@/lib/db/treasuries", () => ({ listCommunityTreasuries: mocks.treasuries }));
vi.mock("@/lib/db/txDetail", () => ({ findCommunityTransaction: mocks.findTx, loadTransactionDetail: mocks.txDetail }));
vi.mock("@/lib/db/assets", () => ({ loadAssetRegistry: mocks.registry }));
vi.mock("@/lib/db/payments", () => ({ loadMemberLabels: mocks.labels }));
vi.mock("@/lib/cardano/cborMetadata", () => ({ decodeTxForDisplay: mocks.decode }));
vi.mock("@/lib/db/funding", () => ({ loadFundingOverview: mocks.funding }));
vi.mock("@/lib/db/calls", () => ({ listCommunityCalls: mocks.calls }));
vi.mock("@/lib/db/tasks", () => ({ taskNumberMap: mocks.numberMap, loadEditableTask: mocks.editable }));
vi.mock("@/lib/db/governance", () => ({
  loadProposalListing: mocks.listing,
  loadProposalEvents: mocks.events,
  loadProposalBallots: mocks.ballots,
  loadTallyDocument: mocks.tally,
  loadDocumentCopies: mocks.copies,
}));

import { listCalls } from "./calls";
import { callEndpoint } from "./endpoint";
import { fundingSummary } from "./funding";
import { proposalDetail } from "./proposals";
import { transactionDetail } from "./transactions";

const caller: ApiCaller = { wallet: "addr_w", scopes: ["communities:read"], clientId: "c1", via: "oauth" };
const COMMUNITY = { id: "c1", slug: "signius", name: "Signius", network: 0, visibility: "private" };
const MAIN = {
  id: "t1", name: "Main", address: "addr_main", network: 0, required: 2, script_type: "atLeast", template: "plain",
  lock_until: null, recovery_script_type: null, recovery_required: null, cosigner_kind: null,
  treasury_signers: [
    { wallet_address: "addr_a", display_name: "Ann", signer_group: "base" },
    { wallet_address: "addr_b", display_name: "Bo", signer_group: "base" },
    { wallet_address: "addr_c", display_name: null, signer_group: "base" },
  ],
};

beforeAll(() => {
  process.env.APP_URL = "http://localhost:3000";
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.community.mockResolvedValue(COMMUNITY);
  mocks.role.mockResolvedValue("member");
  mocks.treasuries.mockResolvedValue([MAIN]);
  mocks.registry.mockResolvedValue([]);
  mocks.labels.mockResolvedValue(new Map([["addr_x", "Xi"]]));
});

describe("transaction_detail", () => {
  const TX = {
    id: "tx-1", treasury_id: "t1", kind: "payout", tx_cbor: "84a0", tx_hash: "h".repeat(64), description: "Payout",
    signed_addresses: ["addr_a"], rejected_addresses: ["addr_c"], state: 0, created_at: "2026-10-01T00:00:00Z",
    submitted_at: null, block_time: null, spending_path: "base", spend_problems: [],
  };

  beforeEach(() => {
    mocks.findTx.mockResolvedValue(TX);
    mocks.txDetail.mockResolvedValue({
      payouts: [{ wallet: "addr_x", unit: "lovelace", amount: "50000000", taskNumber: 12, taskTitle: "Fix login", workgroup: "Development" }],
      payments: [], mints: [],
      decisions: [],
    });
    mocks.decode.mockReturnValue({
      outputs: [], fee: "180000", message: null, mint: [], cip25Meta: null, ttl: null, anchorMeta: null,
      payoutMeta: { v: 3, src: "guild-vault", c: "signius", w: ["Development"], b: ["2026-10"], k: ["ADA"], p: [[0, [[12, 0, 0, ["50"]]]]] },
    });
  });

  it("shows who signed and who is still needed, what it pays, and its on-chain record", async () => {
    const res = await callEndpoint(transactionDetail, caller, { community: "signius", tx: "h".repeat(64) });
    expect(mocks.findTx).toHaveBeenCalledWith(["t1"], "h".repeat(64));
    expect(mocks.decode).toHaveBeenCalledWith("84a0");
    expect(res.signing).toEqual({
      rule: "2 of 3", requiredSignatures: 2,
      signed: [{ name: "Ann", wallet: "addr_a" }],
      rejected: [{ name: null, wallet: "addr_c" }],
      stillToSign: [{ name: "Bo", wallet: "addr_b" }],
      readyToSubmit: false,
    });
    expect(res.payouts).toEqual([{
      recipient: "Xi", wallet: "addr_x", task: 12, taskTitle: "Fix login", workgroup: "Development", token: "ADA", amount: "50",
    }]);
    expect(res.fee).toBe("0.18");
    expect(res.onChainRecord.payout).toMatchObject({ workgroups: ["Development"], taskNumbers: [12] });
    expect(res.transaction).toMatchObject({ id: "tx-1", state: "pending", url: "http://localhost:3000/c/signius/tx/tx-1" });
  });

  it("lists a payment's recipients, transfers and budget month, and its payment record", async () => {
    const HOSKY = "p".repeat(56) + "484f534b59";
    mocks.findTx.mockResolvedValue({ ...TX, kind: "payment", description: "Hosting", state: 2, signed_addresses: ["addr_a", "addr_b"], rejected_addresses: [] });
    mocks.registry.mockResolvedValue([{ fieldName: "HOSKY", unit: HOSKY, decimals: 2 }]);
    const payment = (patch: Record<string, unknown>) => ({
      id: "pm1", transaction_id: "tx-1", community_id: "c1", treasury_id: "t1", recipient_wallet: "addr_x",
      recipient_treasury_id: null, label: null, unit: HOSKY, amount: "150", budget_month: "2026-09-01",
      created_at: "2026-10-01T00:00:00Z", ...patch,
    });
    mocks.txDetail.mockResolvedValue({
      payouts: [], mints: [], decisions: [],
      payments: [
        payment({}),
        payment({ id: "pm2", recipient_wallet: "addr_ops", recipient_treasury_id: "t2", label: "Ops", unit: "lovelace", amount: "10000000", budget_month: null }),
      ],
    });
    mocks.decode.mockReturnValue({
      outputs: [], fee: null, message: ["Hosting"], mint: [], cip25Meta: null, ttl: null, anchorMeta: null,
      payoutMeta: { v: 1, src: "guild-vault", t: "payment", c: "signius", b: "2026-09", k: ["ADA", "HOSKY"], o: [[0, ["", "1.5"], 0], [1, ["10"], 1]] },
    });
    const res = await callEndpoint(transactionDetail, caller, { community: "signius", tx: "tx-1" });
    // A transfer's recipient is a treasury, never looked up as a member.
    expect(mocks.labels).toHaveBeenCalledWith("c1", ["addr_x"]);
    expect(res.payments).toEqual([
      { recipient: "Xi", wallet: "addr_x", transfer: false, budgetMonth: "2026-09", token: "HOSKY", amount: "1.5" },
      { recipient: "Ops", wallet: "addr_ops", transfer: true, budgetMonth: null, token: "ADA", amount: "10" },
    ]);
    expect(res.payouts).toEqual([]);
    expect(res.fee).toBeNull();
    expect(res.message).toEqual(["Hosting"]);
    expect(res.onChainRecord.payout).toBeNull();
    expect(res.onChainRecord.payment).toMatchObject({
      period: "2026-09",
      outputs: [
        { outputIndex: 0, transfer: false, amounts: [{ ticker: "HOSKY", amount: "1.5" }] },
        { outputIndex: 1, transfer: true, amounts: [{ ticker: "ADA", amount: "10" }] },
      ],
    });
    expect(res.onChainRecord.anchors).toBeNull();
    // Confirmed: nobody is still to sign and there is nothing to submit.
    expect(res.signing).toMatchObject({ stillToSign: [], readyToSubmit: false });
    expect(res.transaction).toMatchObject({ kind: "payment", state: "confirmed" });
  });

  it("shows a mint's tokens in display units", async () => {
    mocks.findTx.mockResolvedValue({ ...TX, kind: "mint", description: "Mint GOLD" });
    mocks.txDetail.mockResolvedValue({
      payouts: [], payments: [], decisions: [],
      mints: [
        { asset_name: "Gold", ticker: "GOLD", asset_kind: "ft", quantity: "1500", decimals: 3, recipient: "addr_x", policy_id: "f".repeat(56) },
        { asset_name: "Badge", ticker: null, asset_kind: "nft", quantity: "1", decimals: 0, recipient: "addr_y", policy_id: "f".repeat(56) },
      ],
    });
    const res = await callEndpoint(transactionDetail, caller, { community: "signius", tx: "tx-1" });
    expect(res.mints).toEqual([
      { asset: "Gold", ticker: "GOLD", kind: "ft", quantity: "1.5", recipient: "addr_x", policyId: "f".repeat(56) },
      { asset: "Badge", ticker: null, kind: "nft", quantity: "1", recipient: "addr_y", policyId: "f".repeat(56) },
    ]);
    expect(mocks.labels).toHaveBeenCalledWith("c1", []);
  });

  it("lists the co-signer's decisions and the proposal anchors the transaction carries", async () => {
    mocks.txDetail.mockResolvedValue({
      payouts: [], payments: [], mints: [],
      decisions: [
        { id: "d2", transaction_id: "tx-1", decided_at: "2026-10-01T02:00:00Z", trigger: "manual", passed: true, problems: [], signed: true, error: null },
        { id: "d1", transaction_id: "tx-1", decided_at: "2026-10-01T01:00:00Z", trigger: "sign", passed: false, problems: ["Over budget"], signed: false, error: null },
      ],
    });
    const entries = [[7, "proposed", "a".repeat(64), "b".repeat(64)], [7, "opened", "c".repeat(64)]];
    mocks.decode.mockReturnValue({
      outputs: [], fee: "170000", message: null, mint: [], cip25Meta: null, ttl: null, payoutMeta: null,
      anchorMeta: { v: 1, src: "guild-vault", c: "signius", a: entries },
    });
    const res = await callEndpoint(transactionDetail, caller, { community: "signius", tx: "tx-1" });
    expect(res.cosigner).toEqual([
      { at: "2026-10-01T02:00:00Z", trigger: "manual", passed: true, problems: [], signed: true, error: null },
      { at: "2026-10-01T01:00:00Z", trigger: "sign", passed: false, problems: ["Over budget"], signed: false, error: null },
    ]);
    expect(res.onChainRecord).toEqual({ payout: null, payment: null, anchors: entries });
  });

  it("shows no anchors for a malformed anchor record", async () => {
    mocks.decode.mockReturnValue({
      outputs: [], fee: null, message: null, mint: [], cip25Meta: null, ttl: null, payoutMeta: null,
      anchorMeta: { v: 1, src: "guild-vault", c: "signius", a: [[7, "proposed", "not-a-hash", "b".repeat(64)]] },
    });
    const res = await callEndpoint(transactionDetail, caller, { community: "signius", tx: "tx-1" });
    expect(res.onChainRecord.anchors).toBeNull();
  });

  it("is ready to submit once the rule is met, and still names who has not signed", async () => {
    mocks.findTx.mockResolvedValue({ ...TX, signed_addresses: ["addr_a", "addr_b"], rejected_addresses: [] });
    const res = await callEndpoint(transactionDetail, caller, { community: "signius", tx: "tx-1" });
    expect(res.signing).toEqual({
      rule: "2 of 3", requiredSignatures: 2,
      signed: [{ name: "Ann", wallet: "addr_a" }, { name: "Bo", wallet: "addr_b" }],
      rejected: [],
      stillToSign: [{ name: null, wallet: "addr_c" }],
      readyToSubmit: true,
    });
  });

  it("lists nobody still to sign once the transaction left pending, even short of the rule", async () => {
    mocks.findTx.mockResolvedValue({ ...TX, state: 3 });
    const res = await callEndpoint(transactionDetail, caller, { community: "signius", tx: "tx-1" });
    expect(res.signing).toMatchObject({
      signed: [{ name: "Ann", wallet: "addr_a" }], rejected: [{ name: null, wallet: "addr_c" }], stillToSign: [], readyToSubmit: false,
    });
    expect(res.transaction.state).toBe("rejected");
  });

  it("answers 404 for a transaction of no treasury of the community", async () => {
    mocks.findTx.mockResolvedValue(null);
    await expect(callEndpoint(transactionDetail, caller, { community: "signius", tx: "nope" })).rejects.toBeInstanceOf(NotFoundError);
    expect(mocks.txDetail).not.toHaveBeenCalled();
  });
});

describe("funding_summary", () => {
  it("sums planned against received per source in display units", async () => {
    mocks.funding.mockResolvedValue({
      sources: [{ id: "s1", name: "Catalyst", description: null, url: "https://example.org" }],
      commitments: [{
        id: "k1", source_id: "s1", name: "Fund 12", url: null, note: null, kind: "one_off", cadence: null,
        starts_on: "2026-01-01", ends_on: null, amounts: [{ unit: "lovelace", amount: "100000000000", asset_label: "ADA", decimals: 6 }],
      }],
      periods: [],
      inflows: [{ tx_hash: "i1", amount_lovelace: "40000000000", assets: null, block_time: "2026-02-01T00:00:00Z", funding_source_id: "s1", funding_commitment_id: "k1" }],
    });
    const res = await callEndpoint(fundingSummary, caller, { community: "signius" });
    expect(mocks.funding).toHaveBeenCalledWith("c1", ["t1"]);
    expect(res.sources[0]).toMatchObject({
      name: "Catalyst",
      totals: [{ token: "ADA", planned: "100000", received: "40000", remaining: "60000" }],
      commitments: [{ name: "Fund 12", kind: "one_off", plan: "One-off, expected Jan 2026" }],
    });
    expect(res.url).toBe("http://localhost:3000/c/signius/funding");
  });

  it("shows a schedule's periods and names tokens from the registry, else by their unit", async () => {
    const HOSKY = "p".repeat(56) + "484f534b59";
    const UNKNOWN = "q".repeat(56) + "abcdef";
    mocks.registry.mockResolvedValue([{ fieldName: "HOSKY", unit: HOSKY, decimals: 2 }]);
    mocks.funding.mockResolvedValue({
      sources: [{ id: "s1", name: "Catalyst", description: null, url: null }],
      commitments: [{
        id: "k1", source_id: "s1", name: "Milestones", url: null, note: "Paid per milestone", kind: "schedule", cadence: "monthly",
        starts_on: null, ends_on: null, amounts: [],
      }],
      periods: [
        { commitment_id: "k1", starts_on: "2026-01-01", amounts: [{ unit: "lovelace", amount: "1000000000", asset_label: "ADA", decimals: 6 }] },
        { commitment_id: "k1", starts_on: "2026-02-01", amounts: [{ unit: "lovelace", amount: "1000000000", asset_label: "ADA", decimals: 6 }] },
      ],
      inflows: [
        { tx_hash: "i1", amount_lovelace: "800000000", assets: { [HOSKY]: "150" }, block_time: "2026-01-15T00:00:00Z", funding_source_id: "s1", funding_commitment_id: "k1" },
        // Tied to the source only: unassigned.
        { tx_hash: "i2", amount_lovelace: "0", assets: { [UNKNOWN]: "7" }, block_time: "2026-02-03T00:00:00Z", funding_source_id: "s1", funding_commitment_id: null },
      ],
    });
    const res = await callEndpoint(fundingSummary, caller, { community: "signius" });
    const source = res.sources[0]!;
    expect(source.commitments).toHaveLength(1);
    expect(source.commitments[0]).toMatchObject({
      name: "Milestones", kind: "schedule", plan: "Monthly schedule, Jan 2026 – Feb 2026", note: "Paid per milestone",
    });
    expect(source.commitments[0]!.periods).toEqual([
      { period: "Jan 2026", planned: { ADA: "1000" }, received: { ADA: "800", HOSKY: "1.5" }, runningDifference: { ADA: "-200", HOSKY: "1.5" } },
      { period: "Feb 2026", planned: { ADA: "1000" }, received: {}, runningDifference: { ADA: "-1200", HOSKY: "1.5" } },
    ]);
    // An unknown unit is shown in base units under its fallback name.
    expect(source.unassigned).toEqual({ "TOKEN-ABCDEF": "7" });
    expect(source.totals).toEqual(expect.arrayContaining([
      expect.objectContaining({ token: "ADA", planned: "2000", received: "800", remaining: "1200" }),
      expect.objectContaining({ token: "HOSKY", planned: "0", received: "1.5" }),
      expect.objectContaining({ token: "TOKEN-ABCDEF", received: "7" }),
    ]));
  });
});

describe("call_list", () => {
  const CALL = {
    id: "77777777-7777-4777-8777-777777777777", title: "Town hall", workgroups: { name: "Design" }, provider: "discord",
    starts_at: "2026-10-08T17:00:00Z", ends_at: "2026-10-08T18:00:00Z", amounts: { ADA: "20" }, min_snapshots: 2,
    min_minutes: 0, state: "open",
    call_attendees: [
      { id: "a1", display_name: "Ann", wallet_address: "addr_a", provider: "discord", minutes: 0, snapshots_seen: 3, status: "auto", task_id: null },
      { id: "a2", display_name: "Bo", wallet_address: null, provider: "discord", minutes: 0, snapshots_seen: 3, status: "auto", task_id: null },
      { id: "a3", display_name: "Cy", wallet_address: "addr_c", provider: "discord", minutes: 0, snapshots_seen: 1, status: "auto", task_id: null },
      { id: "a4", display_name: "Di", wallet_address: "addr_d", provider: "discord", minutes: 0, snapshots_seen: 4, status: "auto", task_id: "t-9" },
    ],
  };

  it("counts attendees by standing, and lists one call's attendees with their task", async () => {
    mocks.calls.mockResolvedValue([CALL]);
    mocks.numberMap.mockResolvedValue(new Map([["t-9", 41]]));
    const list = await callEndpoint(listCalls, caller, { community: "signius" });
    expect(mocks.calls).toHaveBeenCalledWith("c1", { state: undefined, callId: undefined, limit: 20 });
    expect(list.calls[0]).toMatchObject({
      title: "Town hall", workgroup: "Design", platform: "discord", rewardEach: { ADA: "20" },
      attendees: { ready: 1, unlinked: 1, "below-threshold": 1, rewarded: 1, excluded: 0 },
    });
    expect(list.attendees).toBeNull();

    const one = await callEndpoint(listCalls, caller, { community: "signius", call: CALL.id });
    expect(one.attendees).toEqual([
      expect.objectContaining({ name: "Ann", standing: "ready", task: null }),
      expect.objectContaining({ name: "Bo", standing: "unlinked" }),
      expect.objectContaining({ name: "Cy", standing: "below-threshold" }),
      expect.objectContaining({ name: "Di", standing: "rewarded", task: 41 }),
    ]);
    mocks.calls.mockResolvedValue([]);
    await expect(callEndpoint(listCalls, caller, { community: "signius", call: CALL.id })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("passes the state filter and the limit on to the read", async () => {
    mocks.calls.mockResolvedValue([]);
    const res = await callEndpoint(listCalls, caller, { community: "signius", state: "finalized", limit: "5" });
    expect(mocks.calls).toHaveBeenCalledExactlyOnceWith("c1", { state: "finalized", callId: undefined, limit: 5 });
    expect(res).toEqual({ community: { slug: "signius", name: "Signius" }, calls: [], attendees: null, url: "http://localhost:3000/c/signius/calls" });
    await expect(callEndpoint(listCalls, caller, { community: "signius", state: "closed" })).rejects.toBeInstanceOf(BadRequestError);
    expect(mocks.calls).toHaveBeenCalledTimes(1);
  });

  it("reads attendees without the platform account ids members never see", () => {
    expect(CALL_ATTENDEE_COLUMNS).not.toContain("external_id");
  });
});

describe("proposal_detail", () => {
  const proposal = (patch: Record<string, unknown> = {}) => ({
    id: "p-7", community_id: "c1", number: 7, kind: "decision", state: "voting", title: "Adopt", body: "x".repeat(3000),
    discussion_url: null, payload: {}, content_hash: "a".repeat(64), rules: rulesFor({ ...DEFAULT_SETTINGS.decision, enabled: true, hideResults: true }),
    rules_hash: "b".repeat(64), proposer: "addr_w", created_at: "2026-10-01T00:00:00Z", voting_starts_at: "2026-10-02T00:00:00Z",
    voting_opened_at: "2026-10-02T00:00:00Z", closes_at: "2026-10-05T00:00:00Z", closed_at: null, electorate_size: 3, ballots_cast: 2,
    tally: null, execution_state: null, execution_error: null, execution_result: null, end_reason: null, electorate_hash: null,
    ...patch,
  });
  const listing = (p: ReturnType<typeof proposal>) => ({
    proposals: [p], total: 1, tallyHashes: new Map(), anchors: new Map(), myVotes: new Map(), mySeats: new Map(),
    handles: new Map(), ownerNames: new Map(),
  });

  beforeEach(() => {
    mocks.events.mockResolvedValue([{ action: "created", actor: "addr_w", detail: null, occurred_at: "2026-10-01T00:00:00Z" }]);
    mocks.ballots.mockResolvedValue({
      voters: [{ wallet_address: "addr_w", recused: false }, { wallet_address: "addr_x", recused: false }, { wallet_address: "addr_y", recused: true }],
      votes: [{ voter: "addr_x", choice: "yes", reason: "Good", signed_at: "2026-10-03T00:00:00Z" }],
    });
    mocks.tally.mockResolvedValue(null);
    mocks.copies.mockResolvedValue([]);
  });

  it("keeps others' ballots secret while a vote with hidden results runs", async () => {
    mocks.listing.mockResolvedValue(listing(proposal()));
    const res = await callEndpoint(proposalDetail, caller, { community: "signius", proposal: 7 });
    expect(mocks.listing).toHaveBeenCalledWith("c1", "addr_w", { open: null, limit: 1, number: 7 });
    expect(res.ballots).toBeNull();
    expect(res.ballotsHidden).toContain("secret");
    expect(res.voters).toBe(3);
    expect(res.recused).toBe(1);
    // The full text, not the list's cut.
    expect(res.proposal.text).toHaveLength(3000);
    expect(res.events).toEqual([{ action: "created", by: expect.any(String), detail: null, at: "2026-10-01T00:00:00Z" }]);
  });

  it("shows every ballot once voting closed, and what carrying it out made", async () => {
    mocks.listing.mockResolvedValue(listing(proposal({
      state: "passed", closed_at: "2026-10-05T00:00:00Z", kind: "task", execution_result: { taskId: "t-3" },
    })));
    mocks.editable.mockResolvedValue({ number: 31, workgroup_id: "wg-1" });
    mocks.tally.mockResolvedValue({ hash: "c".repeat(64), frozen_at: "2026-10-05T00:01:00Z" });
    mocks.copies.mockResolvedValue([{ store: "ipfs", locator: "bafy" }]);
    const res = await callEndpoint(proposalDetail, caller, { community: "signius", proposal: 7 });
    expect(res.ballots).toEqual([{ voter: "Xi", choice: "yes", reason: "Good", signedAt: "2026-10-03T00:00:00Z" }]);
    expect(res.tally).toEqual({ hash: "c".repeat(64), frozenAt: "2026-10-05T00:01:00Z", copies: [{ store: "ipfs", locator: "bafy" }] });
    expect(res.created).toEqual({ taskNumber: 31, taskBoard: "http://localhost:3000/c/signius/boards/wg-1" });
  });

  it("answers 404 for a number the community has not used", async () => {
    mocks.listing.mockResolvedValue({ ...listing(proposal()), proposals: [] });
    await expect(callEndpoint(proposalDetail, caller, { community: "signius", proposal: 99 })).rejects.toBeInstanceOf(NotFoundError);
  });
});
