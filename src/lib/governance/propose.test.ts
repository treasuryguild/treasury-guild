import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BOARD_COLUMNS } from "@/lib/boardTypes";
import { DecisionMethod, ProposalKind } from "@/lib/constants";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "@/lib/errors";
import { DEFAULT_SETTINGS, rulesFor, type GovernanceSettings } from "./rules";

const mocks = vi.hoisted(() => ({
  settings: vi.fn(),
  requireProposer: vi.fn(),
  create: vi.fn(),
  nameTaken: vi.fn(),
  nonMembers: vi.fn(),
  workgroup: vi.fn(),
  leads: vi.fn(),
  revisions: vi.fn(),
  checkBudget: vi.fn(),
  workgroupOwner: vi.fn(),
  treasuryOwner: vi.fn(),
  resolveAmounts: vi.fn(),
  requireActive: vi.fn(),
}));
vi.mock("@/lib/authz", () => ({ requireProposer: mocks.requireProposer }));
vi.mock("@/lib/db/governance", () => ({
  loadGovernanceSettings: mocks.settings,
  createProposal: mocks.create,
  workgroupNameTaken: mocks.nameTaken,
  nonMembers: mocks.nonMembers,
  loadProposalWorkgroup: mocks.workgroup,
  workgroupLeadWallets: mocks.leads,
  loadBudgetRevisions: mocks.revisions,
  checkBudgetProposal: mocks.checkBudget,
}));
vi.mock("@/lib/db/budgetSave", () => ({
  loadWorkgroupBudgetOwner: mocks.workgroupOwner,
  loadTreasuryBudgetOwner: mocks.treasuryOwner,
  resolveBudgetAmounts: mocks.resolveAmounts,
}));
vi.mock("@/lib/db/workgroups", () => ({ requireActiveWorkgroup: mocks.requireActive }));

import { proposalContentHash, proposalRulesHash } from "./hash";
import type { BudgetStep } from "./payload";
import { makeProposal } from "./propose";

type Input = Parameters<typeof makeProposal>[0];
type BudgetInput = Extract<Input, { kind: "budget" }>;

const COMMUNITY = "c-1";
const PROPOSER = "addr_proposer";
const CREATED = { id: "p-1", number: 7, state: "discussion" };
const text = { communityId: COMMUNITY, title: "  A title  ", body: "Why.", discussionUrl: undefined };
const on = (kind: ProposalKind, patch: Partial<GovernanceSettings> = {}): GovernanceSettings =>
  ({ ...DEFAULT_SETTINGS[kind], enabled: true, ...patch });

const decision = { ...text, kind: ProposalKind.Decision } as unknown as Input;
const workgroupInput = (workgroup: { name: string; description: string; leads: string[] }) =>
  ({ ...text, kind: ProposalKind.Workgroup, workgroup }) as unknown as Input;
const taskInput = (task: { workgroupId?: string; amounts?: Record<string, string>; assignSelf?: boolean } = {}) =>
  ({ ...text, kind: ProposalKind.Task, task: { workgroupId: "wg-1", amounts: { ADA: "50" }, assignSelf: false, ...task } }) as unknown as Input;
const BOARD = { community_id: COMMUNITY, name: "Design", kind: "native", archived_at: null };

const created = () => mocks.create.mock.calls[0]![0];

beforeEach(() => {
  vi.resetAllMocks();
  mocks.settings.mockImplementation(async (_community: string, kind: ProposalKind) => on(kind));
  mocks.create.mockResolvedValue(CREATED);
  mocks.nameTaken.mockResolvedValue(false);
  mocks.nonMembers.mockResolvedValue([]);
  mocks.workgroup.mockResolvedValue(BOARD);
  mocks.leads.mockResolvedValue([]);
});

describe("makeProposal: every kind", () => {
  it.each([
    [ProposalKind.Decision, decision, /Proposals of this kind are off/],
    [ProposalKind.Workgroup, workgroupInput({ name: "Ops", description: "", leads: [] }), /Proposals of this kind are off/],
    [ProposalKind.Task, taskInput(), /Proposals of this kind are off/],
    [ProposalKind.Budget, { ...text, kind: ProposalKind.Budget, saves: [] } as unknown as Input, /Budget consent is off/],
  ])("refuses a %s proposal while the kind is off", async (kind, input, message) => {
    mocks.settings.mockResolvedValue(DEFAULT_SETTINGS[kind]);
    const err = await makeProposal(input, PROPOSER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as Error).message).toMatch(message);
    expect(mocks.settings).toHaveBeenCalledWith(COMMUNITY, kind);
    expect(mocks.requireProposer).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("creates nothing for a wallet that may not propose", async () => {
    mocks.requireProposer.mockRejectedValue(new ForbiddenError("Only admins can make this kind of proposal"));
    await expect(makeProposal(decision, PROPOSER)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(makeProposal(taskInput(), PROPOSER)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(makeProposal(workgroupInput({ name: "Ops", description: "", leads: [] }), PROPOSER)).rejects.toBeInstanceOf(ForbiddenError);
    expect(mocks.create).not.toHaveBeenCalled();
    // The proposer check comes before anything is read about the payload.
    expect(mocks.workgroup).not.toHaveBeenCalled();
    expect(mocks.nameTaken).not.toHaveBeenCalled();
  });
});

describe("makeProposal: decision", () => {
  it("freezes the settings' rules and hashes content and rules", async () => {
    const settings = on(ProposalKind.Decision, { quorumPct: 33, votingHours: 96 });
    mocks.settings.mockResolvedValue(settings);
    expect(await makeProposal({ ...decision, discussionUrl: "https://forum.example/t/1" } as unknown as Input, PROPOSER)).toEqual(CREATED);

    const rules = rulesFor(settings);
    const content = {
      kind: ProposalKind.Decision, title: "A title", body: "Why.", discussionUrl: "https://forum.example/t/1", payload: {},
    };
    expect(mocks.requireProposer).toHaveBeenCalledWith(COMMUNITY, PROPOSER, settings.proposers, []);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(created()).toEqual({
      communityId: COMMUNITY,
      ...content,
      contentHash: proposalContentHash(content),
      rules,
      rulesHash: proposalRulesHash(rules),
      workgroupIds: [],
      beneficiaries: [],
      proposer: PROPOSER,
      budgetOwners: [],
    });
    expect(created().rules).toMatchObject({ quorumPct: 33, votingHours: 96, method: settings.method });
    expect(created().contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(created().rulesHash).toMatch(/^[0-9a-f]{64}$/);
    // The settings-only fields never reach the frozen rules.
    expect(created().rules).not.toHaveProperty("enabled");
    expect(created().rules).not.toHaveProperty("lazyCapLovelace");
  });

  it("stores a missing discussion link as null, and hashes differ with the content", async () => {
    await makeProposal(decision, PROPOSER);
    await makeProposal({ ...decision, body: "Another text." } as unknown as Input, PROPOSER);
    const [first, second] = mocks.create.mock.calls.map((call) => call[0]);
    expect(first.discussionUrl).toBeNull();
    expect(first.contentHash).not.toBe(second.contentHash);
    expect(first.rulesHash).toBe(second.rulesHash);
  });
});

describe("makeProposal: workgroup", () => {
  it("refuses a name an active workgroup already has", async () => {
    mocks.nameTaken.mockResolvedValue(true);
    const err = await makeProposal(workgroupInput({ name: " Design ", description: "", leads: [] }), PROPOSER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as Error).message).toBe("A workgroup named Design already exists");
    expect(mocks.nameTaken).toHaveBeenCalledWith(COMMUNITY, "Design");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("refuses a proposed lead who is not a member", async () => {
    mocks.nonMembers.mockResolvedValue(["addr_stranger"]);
    const err = await makeProposal(workgroupInput({ name: "Ops", description: "", leads: ["addr_ann", "addr_stranger"] }), PROPOSER)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestError);
    expect((err as Error).message).toBe("Every proposed lead must be a member");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("carries the trimmed workgroup, its distinct leads as beneficiaries and the default board", async () => {
    await makeProposal(workgroupInput({ name: " Ops ", description: " Runs things ", leads: ["addr_ann", "addr_ann", "addr_bo"] }), PROPOSER);
    expect(mocks.nonMembers).toHaveBeenCalledWith(COMMUNITY, ["addr_ann", "addr_bo"]);
    const payload = {
      workgroup: { name: "Ops", description: "Runs things", leads: ["addr_ann", "addr_bo"] },
      columns: DEFAULT_BOARD_COLUMNS.map((column) => ({ ...column })),
    };
    const rules = rulesFor(on(ProposalKind.Workgroup));
    expect(created()).toMatchObject({
      kind: ProposalKind.Workgroup, payload, workgroupIds: [], beneficiaries: ["addr_ann", "addr_bo"], budgetOwners: [],
      rules, rulesHash: proposalRulesHash(rules),
      contentHash: proposalContentHash({ kind: ProposalKind.Workgroup, title: "A title", body: "Why.", discussionUrl: null, payload }),
    });
  });
});

describe("makeProposal: task", () => {
  it("answers 404 for a missing workgroup and for one of another community", async () => {
    mocks.workgroup.mockResolvedValue(null);
    await expect(makeProposal(taskInput(), PROPOSER)).rejects.toBeInstanceOf(NotFoundError);
    mocks.workgroup.mockResolvedValue({ ...BOARD, community_id: "c-other" });
    const err = await makeProposal(taskInput(), PROPOSER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect((err as Error).message).toBe("Workgroup not found");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("refuses an archived workgroup", async () => {
    mocks.workgroup.mockResolvedValue({ ...BOARD, archived_at: "2026-09-01T00:00:00Z" });
    const err = await makeProposal(taskInput(), PROPOSER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as Error).message).toBe("Design is archived");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("refuses a GitHub board", async () => {
    mocks.workgroup.mockResolvedValue({ ...BOARD, kind: "github" });
    const err = await makeProposal(taskInput(), PROPOSER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestError);
    expect((err as Error).message).toBe("Design is a GitHub board: its tasks come from GitHub issues");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("concerns the task's workgroup and stores the bounty as the board does", async () => {
    await makeProposal(taskInput({ amounts: { ADA: "50.5" } }), PROPOSER);
    const settings = on(ProposalKind.Task);
    expect(mocks.requireProposer).toHaveBeenCalledWith(COMMUNITY, PROPOSER, settings.proposers, ["wg-1"]);
    expect(mocks.workgroup).toHaveBeenCalledWith("wg-1");
    const payload = { task: { workgroupId: "wg-1", amounts: { ADA: "50.5" }, bountyLovelace: "50500000", assignSelf: false } };
    const rules = rulesFor(settings);
    expect(created()).toMatchObject({
      kind: ProposalKind.Task, payload, workgroupIds: ["wg-1"], beneficiaries: [], budgetOwners: [],
      rules, rulesHash: proposalRulesHash(rules),
      contentHash: proposalContentHash({ kind: ProposalKind.Task, title: "A title", body: "Why.", discussionUrl: null, payload }),
    });
  });

  it("makes the proposer the assignee and beneficiary with assignSelf", async () => {
    await makeProposal(taskInput({ assignSelf: true }), PROPOSER);
    expect(created().payload.task.assignSelf).toBe(true);
    expect(created().beneficiaries).toEqual([PROPOSER]);
  });

  it("keeps lazy consensus at or under the cap and without a cap", async () => {
    mocks.settings.mockResolvedValue(on(ProposalKind.Task, { lazyCapLovelace: "50000000" }));
    await makeProposal(taskInput({ amounts: { ADA: "50" } }), PROPOSER);
    expect(created().rules.method).toBe(DecisionMethod.Lazy);

    mocks.create.mockClear();
    mocks.settings.mockResolvedValue(on(ProposalKind.Task, { lazyCapLovelace: null }));
    await makeProposal(taskInput({ amounts: { ADA: "1000000", HOSKY: "5" } }), PROPOSER);
    expect(created().rules.method).toBe(DecisionMethod.Lazy);
  });

  it("escalates the method above the lazy cap, and the rules hash follows", async () => {
    const settings = on(ProposalKind.Task, { lazyCapLovelace: "50000000" });
    mocks.settings.mockResolvedValue(settings);
    await makeProposal(taskInput({ amounts: { ADA: "50.000001" } }), PROPOSER);
    const escalated = rulesFor(settings, { escalate: true });
    expect(escalated.method).toBe(DecisionMethod.Majority);
    expect(created().rules).toEqual(escalated);
    expect(created().rulesHash).toBe(proposalRulesHash(escalated));
    expect(created().rulesHash).not.toBe(proposalRulesHash(rulesFor(settings)));
  });

  it("escalates any other token under a cap, which lovelace cannot measure", async () => {
    mocks.settings.mockResolvedValue(on(ProposalKind.Task, { lazyCapLovelace: "50000000" }));
    await makeProposal(taskInput({ amounts: { HOSKY: "1" } }), PROPOSER);
    expect(created().payload.task.bountyLovelace).toBeNull();
    expect(created().rules.method).toBe(DecisionMethod.Majority);
  });

  it("stays lazy above the cap when the settings name no escalation method", async () => {
    mocks.settings.mockResolvedValue(on(ProposalKind.Task, { lazyCapLovelace: "1", escalateMethod: null }));
    await makeProposal(taskInput(), PROPOSER);
    expect(created().rules.method).toBe(DecisionMethod.Lazy);
  });
});

describe("makeProposal: budget", () => {
  // Far enough ahead that a setup change never starts before voting ends.
  const save = (patch: Record<string, unknown> = {}) => ({
    workgroupId: "wg-1", expectedRevision: 2, mode: "monthly", budgetCadence: "monthly", startsOn: "2999-01",
    budgets: [{ amount: "100", cadence: "monthly" }], confirmTransition: false, reason: "Growth", ...patch,
  });
  const budgetInput = (saves: unknown[]) => ({ ...text, kind: ProposalKind.Budget, saves }) as unknown as BudgetInput;
  const owner = (patch: Record<string, unknown> = {}) => ({
    communityId: COMMUNITY, name: "Design", workgroupId: "wg-1", treasuryId: null, wallet: null, notHeldMessage: "", ...patch,
  });
  const AMOUNTS = [{ unit: "lovelace", amount: "100", asset_label: "ADA", decimals: 6 }];

  beforeEach(() => {
    mocks.workgroupOwner.mockResolvedValue(owner());
    mocks.treasuryOwner.mockResolvedValue(owner({ name: "Treasury: Main", workgroupId: null, treasuryId: "t-1" }));
    mocks.revisions.mockResolvedValue(new Map([["w:wg-1", 2]]));
    mocks.resolveAmounts.mockResolvedValue(AMOUNTS);
    mocks.leads.mockResolvedValue(["addr_lead"]);
  });

  it("stores the saves as resolved steps, dry-runs them and names the owners and their leads", async () => {
    const saves = [save(), save({ workgroupId: null, treasuryId: "t-1", expectedRevision: 0, reason: "Ops" })];
    await makeProposal(budgetInput(saves), PROPOSER);

    const owners = [
      { workgroupId: "wg-1", treasuryId: null, baseRevision: 2 },
      { workgroupId: null, treasuryId: "t-1", baseRevision: 0 },
    ];
    const step = { mode: "monthly" as const, cadence: "monthly" as const, startsOn: "2999-01-01", amounts: AMOUNTS, confirm: false };
    const steps: BudgetStep[] = [
      { workgroupId: "wg-1", treasuryId: null, ...step, reason: "Growth" },
      { workgroupId: null, treasuryId: "t-1", ...step, reason: "Ops" },
    ];
    const settings = on(ProposalKind.Budget);
    expect(mocks.requireProposer).toHaveBeenCalledWith(COMMUNITY, PROPOSER, settings.proposers, ["wg-1"]);
    expect(mocks.requireActive).toHaveBeenCalledWith("wg-1");
    expect(mocks.resolveAmounts).toHaveBeenCalledWith(owner(), saves[0]!.budgets, PROPOSER);
    expect(mocks.checkBudget).toHaveBeenCalledWith(owners, steps, PROPOSER);
    expect(mocks.leads).toHaveBeenCalledWith(["wg-1"]);
    const rules = rulesFor(settings);
    expect(created()).toMatchObject({
      kind: ProposalKind.Budget, payload: { steps }, workgroupIds: ["wg-1"], beneficiaries: ["addr_lead"], budgetOwners: owners,
      rules, rulesHash: proposalRulesHash(rules),
      contentHash: proposalContentHash({ kind: ProposalKind.Budget, title: "A title", body: "Why.", discussionUrl: null, payload: { steps } }),
    });
  });

  it("refuses an owner of another community", async () => {
    mocks.workgroupOwner.mockResolvedValue(owner({ communityId: "c-other" }));
    const err = await makeProposal(budgetInput([save()]), PROPOSER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestError);
    expect((err as Error).message).toBe("Design belongs to another community");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("refuses budgets that changed since the proposer opened the page", async () => {
    mocks.revisions.mockResolvedValue(new Map([["w:wg-1", 3]]));
    await expect(makeProposal(budgetInput([save()]), PROPOSER)).rejects.toBeInstanceOf(ConflictError);
    // An owner with no budget yet is at revision 0.
    mocks.revisions.mockResolvedValue(new Map());
    await expect(makeProposal(budgetInput([save()]), PROPOSER)).rejects.toThrow(/Budgets changed since you opened this page/);
    expect(mocks.checkBudget).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("refuses a budget that is not greater than zero", async () => {
    const err = await makeProposal(budgetInput([save({ budgets: [{ amount: "0", cadence: "monthly" }] })]), PROPOSER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestError);
    expect((err as Error).message).toBe("Each budget must be greater than zero");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("refuses a setup change that would start before voting can end", async () => {
    const err = await makeProposal(budgetInput([save({ startsOn: "2020-01", confirmTransition: true })]), PROPOSER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestError);
    expect((err as Error).message).toMatch(/^A setup change from 2020-01 would be applied after voting ends in \d{4}-\d{2}\. Start it then or later\.$/);
    expect(mocks.checkBudget).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("makes no proposal when the dry run refuses the steps", async () => {
    mocks.checkBudget.mockRejectedValue(new BadRequestError("A later setup exists"));
    await expect(makeProposal(budgetInput([save()]), PROPOSER)).rejects.toThrow("A later setup exists");
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
