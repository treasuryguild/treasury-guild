import { describe, expect, it } from "vitest";
import {
  LEGACY_MAX_CSV_CHARS, LEGACY_MAX_TICKERS, MAX_PAYMENT_MEMO_BYTES, MAX_PAYOUT_CONTRIBUTORS, MAX_PROPOSAL_BODY,
  MAX_PROPOSAL_TITLE, MAX_TASK_ASSIGNEES, MAX_VOTE_REASON,
} from "@/lib/constants";
import { MAX_BUDGET_STEPS } from "@/lib/governance/payload";
import { DEFAULT_SETTINGS, rulesFor } from "@/lib/governance/rules";
import {
  addAttendeesSchema,
  ballotRequestSchema,
  budgetResetSchema,
  buildMintSchema,
  buildPaymentSchema,
  buildPayoutSchema,
  budgetsQuerySchema,
  castVoteSchema,
  chainImportResolveSchema,
  chainImportWorkgroupSchema,
  createCallSchema,
  createCommunitySchema,
  createLegacyWalletSchema,
  createMeetingLinkSchema,
  createProposalSchema,
  dashboardQuerySchema,
  createTreasurySchema,
  discordWebhookUrl,
  electorateQuerySchema,
  endProposalSchema,
  fundingCommitmentSchema,
  fundingScheduleSchema,
  fundingSourceSchema,
  githubSetupQuerySchema,
  governanceSettingsInput,
  incomingDetailsSchema,
  ipfsSignUploadSchema,
  legacyRowsQuerySchema,
  legacyUploadSchema,
  legacyWorkgroupSchema,
  MAX_IMAGE_BYTES,
  oauthDecisionSchema,
  oauthRequestQuerySchema,
  patchAttendeeSchema,
  patchCallSchema,
  patchCommunitySchema,
  patchFundingCommitmentSchema,
  patchFundingSourceSchema,
  patchLegacyWalletSchema,
  patchMeetingLinkSchema,
  reconcileMatchSchema,
  saveGovernanceCommunitySettingsSchema,
  saveGovernanceSettingsSchema,
  setGovernanceDiscordChannelSchema,
  setTreasuryDiscordDestinationSchema,
  setTaskAssigneesSchema,
  treasuryIdQuerySchema,
  txStatusQuerySchema,
  upsertBudgetsSchema,
  walletAddress,
  workgroupRoutingSchema,
} from "./schemas";

const ADDR =
  "addr_test1qp86rhgehcs4k99rpu48879jncjmeytlhv4nxfd3sw2def6xxu4ylafkwgp2ad5l74sa3s75ttr3enxg2ps2qtrpanyswgshl2";

describe("schemas", () => {
  it("validates a call and its reward", () => {
    const call = {
      workgroupId: "20000000-0000-4000-8000-000000000001", provider: "discord", title: " Town hall ",
      startsAt: "2026-09-01T17:00:00.000Z", endsAt: "2026-09-01T18:00:00.000Z", amounts: { ADA: "5", GVTT: "10.5" },
    };
    const parsed = createCallSchema.parse(call);
    expect(parsed).toMatchObject({ title: "Town hall", minSnapshots: 1, minMinutes: 0 });
    expect(createCallSchema.safeParse({ ...call, endsAt: call.startsAt }).success).toBe(false);
    expect(createCallSchema.safeParse({ ...call, amounts: {} }).success).toBe(false);
    expect(createCallSchema.safeParse({ ...call, amounts: { ADA: "0" } }).success).toBe(false);
    expect(createCallSchema.safeParse({ ...call, amounts: { ADA: "1", ada: "2" } }).success).toBe(false);
    expect(createCallSchema.safeParse({ ...call, amounts: { ADA: "1.0000001" } }).success).toBe(false);
    expect(createCallSchema.safeParse({ ...call, provider: "teams" }).success).toBe(false);

    // A Discord voice channel id is a snowflake: digits only.
    expect(parsed.externalRef).toBeNull();
    expect(createCallSchema.parse({ ...call, externalRef: "1153024891357143091" }).externalRef).toBe("1153024891357143091");
    expect(createCallSchema.safeParse({ ...call, externalRef: "lounge" }).success).toBe(false);
    // Zoom meeting id and Meet code; a Meet link is normalised before it is sent.
    expect(createCallSchema.safeParse({ ...call, provider: "zoom", externalRef: "81234567890" }).success).toBe(true);
    expect(createCallSchema.safeParse({ ...call, provider: "meet", externalRef: "abc-mnop-xyz" }).success).toBe(true);
    expect(createCallSchema.safeParse({ ...call, provider: "meet", externalRef: "https://meet.google.com/abc-mnop-xyz" }).success).toBe(false);
    expect(patchCallSchema.safeParse({ externalRef: "1153024891357143091", minSnapshots: 2 }).success).toBe(true);
    expect(patchCallSchema.safeParse({ externalRef: null }).success).toBe(true);

    expect(patchCallSchema.safeParse({}).success).toBe(false);
    expect(patchCallSchema.safeParse({ title: "Renamed" }).success).toBe(true);
    // Start and end move together so the pair stays ordered.
    expect(patchCallSchema.safeParse({ startsAt: call.startsAt }).success).toBe(false);
    expect(patchCallSchema.safeParse({ startsAt: call.endsAt, endsAt: call.startsAt }).success).toBe(false);
  });

  it("validates a linked meeting per platform", () => {
    const link = {
      workgroupId: "20000000-0000-4000-8000-000000000001", meetingRef: "81234567890",
      title: "Town hall", amounts: { ADA: "5" },
    };
    expect(createMeetingLinkSchema.parse(link)).toMatchObject({ provider: "zoom", minMinutes: 0, durationMinutes: 60 });
    expect(createMeetingLinkSchema.safeParse({ ...link, meetingRef: "812 3456 7890" }).success).toBe(false);
    expect(createMeetingLinkSchema.safeParse({ ...link, provider: "meet", meetingRef: "abc-mnop-xyz" }).success).toBe(true);
    // The reference has the shape of its platform.
    expect(createMeetingLinkSchema.safeParse({ ...link, provider: "meet" }).success).toBe(false);
    expect(createMeetingLinkSchema.safeParse({ ...link, meetingRef: "abc-mnop-xyz" }).success).toBe(false);
    expect(createMeetingLinkSchema.safeParse({ ...link, provider: "discord" }).success).toBe(false);
  });

  it("validates attendee edits", () => {
    const attendeeId = "70000000-0000-4000-8000-000000000001";
    expect(addAttendeesSchema.safeParse({ kind: "names", names: ["Alice", " Bob "] }).success).toBe(true);
    expect(addAttendeesSchema.safeParse({ kind: "names", names: [] }).success).toBe(false);
    expect(addAttendeesSchema.safeParse({ kind: "wallet", wallet: ADDR }).success).toBe(true);
    expect(addAttendeesSchema.safeParse({ kind: "wallet", wallet: "nope" }).success).toBe(false);
    expect(patchAttendeeSchema.parse({ attendeeId, wallet: ADDR })).toMatchObject({ remember: false });
    expect(patchAttendeeSchema.safeParse({ attendeeId, wallet: null }).success).toBe(true);
    expect(patchAttendeeSchema.safeParse({ attendeeId, status: "excluded" }).success).toBe(true);
    expect(patchAttendeeSchema.safeParse({ attendeeId }).success).toBe(false);
    expect(patchAttendeeSchema.safeParse({ attendeeId, status: "paid" }).success).toBe(false);
  });

  it("validates a workgroup wallet change", () => {
    const workgroupId = "20000000-0000-4000-8000-000000000001";
    const treasuryId = "40000000-0000-4000-8000-000000000001";
    expect(workgroupRoutingSchema.safeParse({ workgroupId, treasuryId, effective: "next" }).success).toBe(true);
    expect(workgroupRoutingSchema.parse({ workgroupId, treasuryId: null, effective: "current", reason: "  Merged  " }).reason).toBe("Merged");
    expect(workgroupRoutingSchema.safeParse({ workgroupId, treasuryId: "wallet", effective: "next" }).success).toBe(false);
    expect(workgroupRoutingSchema.safeParse({ workgroupId, treasuryId, effective: "later" }).success).toBe(false);
    expect(workgroupRoutingSchema.safeParse({ workgroupId, treasuryId, effective: "next", reason: "x".repeat(501) }).success).toBe(false);
  });
  it("requires a treasury id for the details query", () => {
    expect(treasuryIdQuerySchema.safeParse({ treasuryId: "40000000-0000-4000-8000-000000000002" }).success).toBe(true);
    // Ids are UUIDs: anything else is refused before it reaches a uuid column.
    expect(treasuryIdQuerySchema.safeParse({ treasuryId: "t1" }).success).toBe(false);
    expect(treasuryIdQuerySchema.safeParse({ treasuryId: "" }).success).toBe(false);
    expect(treasuryIdQuerySchema.safeParse({}).success).toBe(false);
  });
  it("accepts quarterly plans and requires quarter boundaries and matching row cadence", () => {
    const input = { workgroupId: "20000000-0000-4000-8000-000000000002", budgetCadence: "quarterly", budgetMonth: "2026-10",
      budgets: [{ unit: "lovelace", cadence: "quarterly", amount: "3000000" }] };
    expect(upsertBudgetsSchema.safeParse(input).success).toBe(true);
    expect(upsertBudgetsSchema.safeParse({ ...input, budgets: [] }).success).toBe(true);
    expect(upsertBudgetsSchema.safeParse({ ...input, budgetMonth: "2026-11" }).success).toBe(false);
    expect(upsertBudgetsSchema.safeParse({ ...input, budgets: [{ ...input.budgets[0], cadence: "monthly" }] }).success).toBe(false);
    expect(budgetsQuerySchema.safeParse({ communityId: "10000000-0000-4000-8000-000000000001", month: "2026-12", view: "quarter" }).success).toBe(true);
    expect(dashboardQuerySchema.safeParse({ communityId: "10000000-0000-4000-8000-000000000001", month: "2026-12", view: "quarter" }).success).toBe(true);
    expect(dashboardQuerySchema.parse({ communityId: "10000000-0000-4000-8000-000000000001" }).view).toBe("month");
    expect(dashboardQuerySchema.safeParse({ communityId: "10000000-0000-4000-8000-000000000001", view: "recurring" }).success).toBe(false);
    // All time is the Dashboard's alone.
    expect(dashboardQuerySchema.parse({ communityId: "10000000-0000-4000-8000-000000000001", view: "all" }).view).toBe("all");
    expect(budgetsQuerySchema.safeParse({ communityId: "10000000-0000-4000-8000-000000000001", view: "all" }).success).toBe(false);
  });
  it("validates dated budget months for reads and writes", () => {
    const input = { workgroupId: "20000000-0000-4000-8000-000000000002", budgets: [{ unit: "lovelace", cadence: "monthly", amount: "1000000" }] };
    expect(upsertBudgetsSchema.parse({ ...input, budgetMonth: "2026-09" }).budgetMonth).toBe("2026-09");
    expect(upsertBudgetsSchema.parse(input).budgetMonth).toBeNull();
    for (const month of ["2026-00", "2026-13", "2026-9", "2026-09-01", "", "0000-01"]) {
      expect(upsertBudgetsSchema.safeParse({ ...input, budgetMonth: month }).success).toBe(false);
      expect(budgetsQuerySchema.safeParse({ communityId: "10000000-0000-4000-8000-000000000001", month }).success).toBe(false);
      expect(dashboardQuerySchema.safeParse({ communityId: "10000000-0000-4000-8000-000000000001", month }).success).toBe(false);
    }
    expect(upsertBudgetsSchema.safeParse({ ...input, budgetMonth: "2026-09", budgets: [{ ...input.budgets[0], cadence: "quarterly" }] }).success).toBe(false);
    expect(upsertBudgetsSchema.safeParse({ ...input, budgetMonth: "2026-09", budgets: [] }).success).toBe(true);
  });
  it("validates wallet addresses through the SDK", () => {
    expect(walletAddress.safeParse(ADDR).success).toBe(true);
    expect(walletAddress.safeParse("addr_test1garbage").success).toBe(false);
  });

  it("enforces the community slug shape, trims names and requires a network", () => {
    expect(
      createCommunitySchema.parse({ slug: "my-dao", name: "  DAO  ", network: 0 }),
    ).toEqual({ slug: "my-dao", name: "DAO", network: 0, visibility: "private" });
    expect(
      createCommunitySchema.parse({
        slug: "my-dao", name: "DAO", network: 1, visibility: "public",
      }),
    ).toEqual({ slug: "my-dao", name: "DAO", network: 1, visibility: "public" });
    expect(
      createCommunitySchema.safeParse({ slug: "My DAO", name: "x", network: 1 }).success,
    ).toBe(false);
    // The network is chosen explicitly; there is no server-side default.
    expect(createCommunitySchema.safeParse({ slug: "my-dao", name: "x" }).success).toBe(false);
    expect(
      createCommunitySchema.safeParse({ slug: "my-dao", name: "x", network: 2 }).success,
    ).toBe(false);
    expect(
      createCommunitySchema.safeParse({
        slug: "my-dao", name: "x", network: 0, visibility: "secret",
      }).success,
    ).toBe(false);
  });

  it("defaults the treasury script type", () => {
    const parsed = createTreasurySchema.parse({
      communityId: "10000000-0000-4000-8000-000000000001",
      name: "Main",
      signers: [{ address: ADDR }],
    });
    expect(parsed.scriptType).toBe("atLeast");
    expect(parsed.required).toBeUndefined();
    expect(parsed.workgroupId).toBeUndefined();
  });

  it("takes an optional workgroup to link a new treasury to", () => {
    const base = { communityId: "10000000-0000-4000-8000-000000000001", name: "Dev", signers: [{ address: ADDR }] };
    const workgroupId = "20000000-0000-4000-8000-000000000001";
    expect(createTreasurySchema.parse({ ...base, workgroupId }).workgroupId).toBe(workgroupId);
    expect(createTreasurySchema.parse({ ...base, workgroupId: null }).workgroupId).toBeNull();
    expect(createTreasurySchema.safeParse({ ...base, workgroupId: "dev" }).success).toBe(false);
  });

  it("patches community settings one field at a time, normalising the rate setting", () => {
    expect(patchCommunitySchema.parse({ communityId: "10000000-0000-4000-8000-000000000001", visibility: "public" })).toEqual({
      communityId: "10000000-0000-4000-8000-000000000001",
      visibility: "public",
    });
    expect(
      patchCommunitySchema.parse({ communityId: "10000000-0000-4000-8000-000000000001", discordRateCoin: " SingularityNET ", discordRateCurrency: "EUR" }),
    ).toEqual({ communityId: "10000000-0000-4000-8000-000000000001", discordRateCoin: "singularitynet", discordRateCurrency: "eur" });
    expect(patchCommunitySchema.parse({ communityId: "10000000-0000-4000-8000-000000000001", discordRateCoin: null }).discordRateCoin).toBeNull();
    expect(patchCommunitySchema.safeParse({ communityId: "10000000-0000-4000-8000-000000000001" }).success).toBe(false);
    expect(patchCommunitySchema.safeParse({ communityId: "10000000-0000-4000-8000-000000000001", discordRateCoin: "bad id!" }).success).toBe(false);
    expect(patchCommunitySchema.safeParse({ communityId: "10000000-0000-4000-8000-000000000001", discordRateCurrency: "us" }).success).toBe(false);
  });

  it("accepts lovelace or a native asset unit as the main spending token", () => {
    const unit = "A".repeat(56) + "48454c4c4f";
    expect(patchCommunitySchema.parse({ communityId: "10000000-0000-4000-8000-000000000001", spendingUnit: "lovelace" })).toEqual({
      communityId: "10000000-0000-4000-8000-000000000001",
      spendingUnit: "lovelace",
    });
    expect(patchCommunitySchema.parse({ communityId: "10000000-0000-4000-8000-000000000001", spendingUnit: ` ${unit} ` }).spendingUnit).toBe(unit.toLowerCase());
    for (const bad of ["ADA", "abc", "", "a".repeat(55)]) {
      expect(patchCommunitySchema.safeParse({ communityId: "10000000-0000-4000-8000-000000000001", spendingUnit: bad }).success).toBe(false);
    }
  });

  it("accepts only Discord webhook URLs", () => {
    const token = "aBc-DEF_123";
    for (const host of ["discord.com", "discordapp.com", "ptb.discord.com", "canary.discord.com"]) {
      expect(discordWebhookUrl.safeParse(` https://${host}/api/webhooks/123456/${token} `).success).toBe(true);
    }
    for (const bad of [
      "http://discord.com/api/webhooks/1/tok",
      "https://discord.com/api/webhooks/1",
      "https://discord.com/api/webhooks/abc/tok",
      "https://evil.com/api/webhooks/1/tok",
      "https://discord.com/api/webhooks/1/tok?x=1",
      "",
    ]) {
      expect(discordWebhookUrl.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("discriminates mint policy modes", () => {
    const base = {
      treasuryId: "40000000-0000-4000-8000-000000000002",
      assetKind: "nft",
      assets: [{ name: "One", imageCid: "Qm" }],
    };
    expect(buildMintSchema.parse({ ...base, policy: { mode: "treasury" } }).policy).toEqual({
      mode: "treasury",
    });
    expect(
      buildMintSchema.parse({ ...base, policy: { mode: "locked", lockSlot: 5 } }).policy,
    ).toEqual({ mode: "locked", lockSlot: 5 });
    expect(buildMintSchema.safeParse({ ...base, policy: { mode: "other" } }).success).toBe(
      false,
    );
    expect(buildMintSchema.safeParse({ ...base, assets: [] }).success).toBe(false);
    expect(buildMintSchema.safeParse({ ...base, decimals: 13 }).success).toBe(false);
  });

  it("bounds image uploads", () => {
    const ok = { communityId: "10000000-0000-4000-8000-000000000001", mimeType: "image/png", size: 1024 };
    expect(ipfsSignUploadSchema.safeParse(ok).success).toBe(true);
    expect(ipfsSignUploadSchema.safeParse({ ...ok, mimeType: "text/plain" }).success).toBe(
      false,
    );
    expect(
      ipfsSignUploadSchema.safeParse({ ...ok, size: MAX_IMAGE_BYTES + 1 }).success,
    ).toBe(false);
  });

  it("validates task assignee sets", () => {
    // z.uuid() checks the RFC 4122 version/variant bits (gen_random_uuid() is v4).
    const taskId = "30000000-0000-4000-8000-000000000001";
    const ghId = "70000000-0000-4000-8000-000000000001";
    const ok = {
      taskId,
      assignees: [
        { source: "github", id: ghId, wallet: null },
        { source: "manual", wallet: ADDR },
      ],
    };
    expect(setTaskAssigneesSchema.safeParse(ok).success).toBe(true);
    expect(setTaskAssigneesSchema.safeParse({ taskId, assignees: [] }).success).toBe(true);
    // manual rows need a valid wallet; github rows need a uuid id
    expect(
      setTaskAssigneesSchema.safeParse({ taskId, assignees: [{ source: "manual", wallet: null }] }).success,
    ).toBe(false);
    expect(
      setTaskAssigneesSchema.safeParse({ taskId, assignees: [{ source: "manual", wallet: "addr_test1garbage" }] })
        .success,
    ).toBe(false);
    expect(
      setTaskAssigneesSchema.safeParse({ taskId, assignees: [{ source: "github", id: "x", wallet: ADDR }] }).success,
    ).toBe(false);
    // a wallet listed twice would be paid twice
    expect(
      setTaskAssigneesSchema.safeParse({
        taskId,
        assignees: [{ source: "github", id: ghId, wallet: ADDR }, { source: "manual", wallet: ADDR }],
      }).success,
    ).toBe(false);
    expect(
      setTaskAssigneesSchema.safeParse({
        taskId,
        assignees: Array.from({ length: MAX_TASK_ASSIGNEES + 1 }, () => ({ source: "github", id: ghId, wallet: null })),
      }).success,
    ).toBe(false);
  });

  it("accepts a batch of distinct token budgets and rejects duplicate tokens", () => {
    const input = {
      workgroupId: "20000000-0000-4000-8000-000000000002",
      budgets: [
        { unit: "lovelace", cadence: "monthly", amount: "1000000" },
        { unit: "a".repeat(64), cadence: "quarterly", amount: "200000" },
      ],
    };
    expect(upsertBudgetsSchema.safeParse(input).success).toBe(true);
    expect(
      upsertBudgetsSchema.safeParse({ workgroupId: "20000000-0000-4000-8000-000000000002", budgets: [] })
        .success,
    ).toBe(true);
    expect(
      upsertBudgetsSchema.safeParse({
        ...input,
        budgets: [input.budgets[0], input.budgets[0]],
      }).success,
    ).toBe(false);
  });
});

const COMMUNITY = "10000000-0000-4000-8000-000000000001";
const TREASURY = "40000000-0000-4000-8000-000000000001";
const WORKGROUP = "20000000-0000-4000-8000-000000000001";
const SOURCE = "50000000-0000-4000-8000-000000000001";
const TX_HASH = "ab".repeat(32);
const ASSET_UNIT = "a".repeat(56) + "48454c4c4f";

/** Every issue message of a failed parse (empty when it succeeded). */
function messages(result: { success: boolean; error?: { issues: { message: string }[] } }): string[] {
  return result.success ? [] : result.error!.issues.map((issue) => issue.message);
}

describe("createProposalSchema", () => {
  const text = { communityId: COMMUNITY, title: "  Fund the docs sprint  " };

  it("parses a decision, trimming the title and defaulting the body", () => {
    expect(createProposalSchema.parse({ kind: "decision", ...text })).toEqual({
      kind: "decision", communityId: COMMUNITY, title: "Fund the docs sprint", body: "",
    });
    // An empty link field means no link.
    expect(createProposalSchema.parse({ kind: "decision", ...text, discussionUrl: "" })).toMatchObject({ discussionUrl: null });
    expect(createProposalSchema.parse({ kind: "decision", ...text, discussionUrl: " https://forum.test/t/1 " }))
      .toMatchObject({ discussionUrl: "https://forum.test/t/1" });
    expect(createProposalSchema.safeParse({ kind: "decision", ...text, discussionUrl: "javascript:alert(1)" }).success).toBe(false);
    expect(createProposalSchema.safeParse({ kind: "decision", ...text, discussionUrl: "forum.test/t/1" }).success).toBe(false);
  });

  it("bounds the title and the body", () => {
    const base = { kind: "decision", communityId: COMMUNITY };
    expect(createProposalSchema.safeParse({ ...base, title: "x".repeat(MAX_PROPOSAL_TITLE) }).success).toBe(true);
    expect(createProposalSchema.safeParse({ ...base, title: "x".repeat(MAX_PROPOSAL_TITLE + 1) }).success).toBe(false);
    expect(createProposalSchema.safeParse({ ...base, title: "   " }).success).toBe(false);
    expect(createProposalSchema.safeParse({ ...base }).success).toBe(false);
    expect(createProposalSchema.safeParse({ ...base, title: "T", body: "x".repeat(MAX_PROPOSAL_BODY) }).success).toBe(true);
    expect(createProposalSchema.safeParse({ ...base, title: "T", body: "x".repeat(MAX_PROPOSAL_BODY + 1) }).success).toBe(false);
  });

  it("accepts rules within the settings bounds and refuses the rest", () => {
    const rules = rulesFor(DEFAULT_SETTINGS.decision);
    expect(createProposalSchema.parse({ kind: "decision", ...text, rules })).toMatchObject({ rules });
    expect(createProposalSchema.parse({
      kind: "decision", ...text, replacesProposalId: "10000000-0000-4000-8000-000000000001",
    })).toMatchObject({ replacesProposalId: "10000000-0000-4000-8000-000000000001" });
    expect(createProposalSchema.safeParse({ kind: "decision", ...text, replacesProposalId: "not-a-uuid" }).success).toBe(false);
    const bad = (patch: Record<string, unknown>) =>
      createProposalSchema.safeParse({ kind: "decision", ...text, rules: { ...rules, ...patch } }).success;
    expect(bad({ quorumPct: 0 })).toBe(true);
    expect(bad({ quorumPct: 100 })).toBe(true);
    expect(bad({ quorumPct: 101 })).toBe(false);
    expect(bad({ thresholdPct: 50 })).toBe(true);
    expect(bad({ thresholdPct: 49 })).toBe(false);
    expect(bad({ thresholdPct: 99 })).toBe(true);
    expect(bad({ discussionHours: 0 })).toBe(true);
    expect(bad({ discussionHours: 336 })).toBe(true);
    expect(bad({ discussionHours: 337 })).toBe(false);
    expect(bad({ votingHours: 1 })).toBe(true);
    expect(bad({ votingHours: 720 })).toBe(true);
    expect(bad({ votingHours: 0 })).toBe(false);
    expect(bad({ activityMonths: 1 })).toBe(true);
    expect(bad({ activityMonths: 37 })).toBe(false);
    expect(bad({ minMemberDays: 365 })).toBe(true);
    expect(bad({ minMemberDays: -1 })).toBe(false);
    expect(bad({ lazyObjections: 1 })).toBe(true);
    expect(bad({ lazyObjections: 0 })).toBe(false);
    expect(bad({ method: "straw" })).toBe(false);
  });

  it("refuses an unknown kind and a community id that is not a uuid", () => {
    expect(createProposalSchema.safeParse({ kind: "payout", ...text }).success).toBe(false);
    expect(createProposalSchema.safeParse({ ...text }).success).toBe(false);
    expect(createProposalSchema.safeParse({ kind: "decision", title: "T", communityId: "demo" }).success).toBe(false);
  });

  describe("workgroup", () => {
    const proposal = (workgroup: unknown) => ({ kind: "workgroup", ...text, workgroup });

    it("trims the name and defaults the description and the leads", () => {
      expect(createProposalSchema.parse(proposal({ name: "  Docs  " }))).toMatchObject({
        kind: "workgroup", workgroup: { name: "Docs", description: "", leads: [] },
      });
    });

    it("caps the name at 80 characters and refuses an empty one", () => {
      expect(createProposalSchema.safeParse(proposal({ name: "n".repeat(80) })).success).toBe(true);
      expect(createProposalSchema.safeParse(proposal({ name: "n".repeat(81) })).success).toBe(false);
      expect(createProposalSchema.safeParse(proposal({ name: "   " })).success).toBe(false);
      expect(createProposalSchema.safeParse(proposal({})).success).toBe(false);
      expect(createProposalSchema.safeParse({ kind: "workgroup", ...text }).success).toBe(false);
    });

    it("caps the description at 1000 characters", () => {
      expect(createProposalSchema.safeParse(proposal({ name: "Docs", description: "d".repeat(1000) })).success).toBe(true);
      expect(createProposalSchema.safeParse(proposal({ name: "Docs", description: "d".repeat(1001) })).success).toBe(false);
    });

    it("takes at most 10 leads, each a non-empty stored wallet (no bech32 check)", () => {
      const leads = (n: number) => Array.from({ length: n }, (_, i) => `addr_test1lead${i}`);
      expect(createProposalSchema.parse(proposal({ name: "Docs", leads: leads(10) }))).toMatchObject({ workgroup: { leads: leads(10) } });
      expect(createProposalSchema.safeParse(proposal({ name: "Docs", leads: leads(11) })).success).toBe(false);
      expect(createProposalSchema.safeParse(proposal({ name: "Docs", leads: [""] })).success).toBe(false);
      expect(createProposalSchema.safeParse(proposal({ name: "Docs", leads: ["a".repeat(201)] })).success).toBe(false);
    });
  });

  describe("task", () => {
    const proposal = (task: unknown) => ({ kind: "task", ...text, task });

    it("takes a workgroup and a reward, and does not assign the proposer by default", () => {
      expect(createProposalSchema.parse(proposal({ workgroupId: WORKGROUP, amounts: { ADA: "5", GVTT: "10.5" } }))).toMatchObject({
        kind: "task", task: { workgroupId: WORKGROUP, amounts: { ADA: "5", GVTT: "10.5" }, assignSelf: false },
      });
      expect(createProposalSchema.parse(proposal({ workgroupId: WORKGROUP, amounts: { ADA: "5" }, assignSelf: true })))
        .toMatchObject({ task: { assignSelf: true } });
      expect(createProposalSchema.safeParse(proposal({ workgroupId: WORKGROUP, amounts: { ADA: "5" }, assignSelf: "yes" })).success).toBe(false);
    });

    it("needs a workgroup id", () => {
      expect(createProposalSchema.safeParse(proposal({ amounts: { ADA: "5" } })).success).toBe(false);
      expect(createProposalSchema.safeParse(proposal({ workgroupId: "docs", amounts: { ADA: "5" } })).success).toBe(false);
    });

    it("applies the reward rules of a task bounty", () => {
      const reward = (amounts: unknown) => createProposalSchema.safeParse(proposal({ workgroupId: WORKGROUP, amounts }));
      // No reward at all.
      expect(messages(reward({}))).toEqual(["Set a reward per attendee"]);
      expect(reward(undefined).success).toBe(false);
      // Zero is not a reward.
      expect(messages(reward({ ADA: "0" }))).toEqual(["Invalid amount for ADA"]);
      // Tickers are compared case-insensitively: the same token twice.
      expect(messages(reward({ ADA: "1", ada: "2" }))).toEqual(["Duplicate ticker ada"]);
      // ADA has 6 decimals; another token's decimals are unknown here.
      expect(messages(reward({ ADA: "1.0000001" }))).toEqual(["ADA supports at most 6 decimal places"]);
      expect(reward({ ADA: "1.000001" }).success).toBe(true);
      expect(reward({ GVTT: "1.0000001" }).success).toBe(true);
      // Plain positive decimals only.
      for (const amount of ["-1", "1e3", "1,5", ".5", "5.", "abc", ""]) {
        expect(reward({ ADA: amount }).success, amount).toBe(false);
      }
      expect(reward({ ADA: 5 }).success).toBe(false);
    });
  });

  describe("budget", () => {
    const save = {
      workgroupId: WORKGROUP, budgetCadence: "monthly", mode: "monthly", startsOn: "2026-09", expectedRevision: 0,
      budgets: [{ unit: "lovelace", cadence: "monthly", amount: "1000000" }],
    };
    const proposal = (saves: unknown) => ({ kind: "budget", ...text, saves });

    it("carries the worksheet's saves, each parsed as a budget setup save", () => {
      const parsed = createProposalSchema.parse(proposal([save]));
      expect(parsed).toMatchObject({ kind: "budget", saves: [{ workgroupId: WORKGROUP, startsOn: "2026-09", confirmTransition: false, reason: "" }] });
    });

    it("needs at least one save and at most MAX_BUDGET_STEPS", () => {
      expect(messages(createProposalSchema.safeParse(proposal([])))).toEqual(["Change at least one budget"]);
      expect(createProposalSchema.safeParse({ kind: "budget", ...text }).success).toBe(false);
      expect(createProposalSchema.safeParse(proposal(Array(MAX_BUDGET_STEPS).fill(save))).success).toBe(true);
      expect(createProposalSchema.safeParse(proposal(Array(MAX_BUDGET_STEPS + 1).fill(save))).success).toBe(false);
    });

    it("refuses a save the worksheet itself would refuse", () => {
      // Two owners, a cadence mismatch, a quarterly plan off a quarter boundary.
      expect(createProposalSchema.safeParse(proposal([{ ...save, treasuryId: "40000000-0000-4000-8000-000000000001" }])).success).toBe(false);
      expect(createProposalSchema.safeParse(proposal([{ ...save, mode: "quarterly" }])).success).toBe(false);
      const quarterly = { ...save, budgetCadence: "quarterly", mode: "quarterly", budgets: [{ ...save.budgets[0], cadence: "quarterly" }] };
      expect(createProposalSchema.safeParse(proposal([{ ...quarterly, startsOn: "2026-10" }])).success).toBe(true);
      expect(messages(createProposalSchema.safeParse(proposal([{ ...quarterly, startsOn: "2026-09" }])))).toEqual(["Choose a quarter boundary"]);
    });
  });
});

describe("governance schemas", () => {
  const settings = {
    enabled: true, proposers: "members", electorate: "members", activityMonths: 6, minMemberDays: 0,
    method: "consent", quorumPct: 20, thresholdPct: 50, lazyObjections: 1, lazyCapLovelace: null,
    escalateMethod: null, discussionHours: 72, votingHours: 72, hideResults: false, recuseBeneficiaries: true,
  };

  it("saves one kind's settings, every field required", () => {
    expect(saveGovernanceSettingsSchema.safeParse({ communityId: COMMUNITY, kind: "budget", settings }).success).toBe(true);
    expect(saveGovernanceSettingsSchema.safeParse({ communityId: COMMUNITY, kind: "poll", settings }).success).toBe(false);
    for (const key of Object.keys(settings)) {
      const partial: Record<string, unknown> = { ...settings };
      delete partial[key];
      expect(governanceSettingsInput.safeParse(partial).success, key).toBe(false);
    }
  });

  it("validates the community-level settings: a known store or none, and a spending-check mode", () => {
    const ok = (body: Record<string, unknown>) =>
      saveGovernanceCommunitySettingsSchema.safeParse({ communityId: COMMUNITY, ...body }).success;
    expect(ok({ documentStore: "ipfs", spendCheck: "warn" })).toBe(true);
    expect(ok({ documentStore: null, spendCheck: "refuse" })).toBe(true);
    expect(ok({ documentStore: "github", documentArchiveRepoId: 42, spendCheck: "warn" })).toBe(true);
    expect(ok({ documentStore: "github", spendCheck: "warn" })).toBe(false);
    expect(ok({ documentStore: "arweave", spendCheck: "warn" })).toBe(false);
    expect(ok({ documentStore: null, spendCheck: "ignore" })).toBe(false);
    expect(ok({ documentStore: null })).toBe(false);
  });

  it("bounds each numeric setting", () => {
    const ok = (over: Record<string, unknown>) => governanceSettingsInput.safeParse({ ...settings, ...over }).success;
    expect(ok({ activityMonths: 1 }) && ok({ activityMonths: 36 })).toBe(true);
    expect(ok({ activityMonths: 0 }) || ok({ activityMonths: 37 })).toBe(false);
    expect(ok({ minMemberDays: 365 })).toBe(true);
    expect(ok({ minMemberDays: -1 }) || ok({ minMemberDays: 366 })).toBe(false);
    expect(ok({ quorumPct: 0 }) && ok({ quorumPct: 100 })).toBe(true);
    expect(ok({ quorumPct: 101 })).toBe(false);
    // A support threshold below half would let a minority pass a proposal; 100 % is consent's job.
    expect(ok({ thresholdPct: 50 }) && ok({ thresholdPct: 99 })).toBe(true);
    expect(ok({ thresholdPct: 49 }) || ok({ thresholdPct: 100 })).toBe(false);
    expect(ok({ lazyObjections: 50 })).toBe(true);
    expect(ok({ lazyObjections: 0 }) || ok({ lazyObjections: 51 })).toBe(false);
    expect(ok({ discussionHours: 0 }) && ok({ discussionHours: 336 })).toBe(true);
    expect(ok({ discussionHours: 337 })).toBe(false);
    // Voting cannot be instant.
    expect(ok({ votingHours: 1 }) && ok({ votingHours: 720 })).toBe(true);
    expect(ok({ votingHours: 0 }) || ok({ votingHours: 721 })).toBe(false);
    expect(ok({ quorumPct: 20.5 })).toBe(false);
  });

  it("takes the lazy cap as a positive lovelace string and escalates to a voted method only", () => {
    const ok = (over: Record<string, unknown>) => governanceSettingsInput.safeParse({ ...settings, ...over }).success;
    expect(ok({ lazyCapLovelace: "500000000" })).toBe(true);
    expect(ok({ lazyCapLovelace: "9".repeat(18) })).toBe(true);
    for (const cap of ["0", "0500", "1.5", "-1", "", "9".repeat(19)]) expect(ok({ lazyCapLovelace: cap }), cap).toBe(false);
    expect(ok({ lazyCapLovelace: 500 })).toBe(false);
    expect(ok({ escalateMethod: "consent" }) && ok({ escalateMethod: "majority" })).toBe(true);
    expect(ok({ escalateMethod: "lazy" })).toBe(false);
    expect(ok({ method: "lazy" })).toBe(true);
    expect(ok({ method: "ranked" }) || ok({ proposers: "leads" }) || ok({ electorate: "everyone" })).toBe(false);
  });

  it("splits the electorate query's workgroup ids", () => {
    const other = "20000000-0000-4000-8000-000000000002";
    const base = { communityId: COMMUNITY, kind: "task" };
    expect(electorateQuerySchema.parse(base).workgroupIds).toEqual([]);
    expect(electorateQuerySchema.parse({ ...base, workgroupIds: "" }).workgroupIds).toEqual([]);
    expect(electorateQuerySchema.parse({ ...base, workgroupIds: `${WORKGROUP},${other}` }).workgroupIds).toEqual([WORKGROUP, other]);
    // Empty segments are dropped, not parsed as ids.
    expect(electorateQuerySchema.parse({ ...base, workgroupIds: `,${WORKGROUP},,` }).workgroupIds).toEqual([WORKGROUP]);
    expect(electorateQuerySchema.safeParse({ ...base, workgroupIds: `${WORKGROUP},docs` }).success).toBe(false);
    expect(electorateQuerySchema.safeParse({ ...base, workgroupIds: ` ${WORKGROUP}` }).success).toBe(false);
    expect(electorateQuerySchema.safeParse({ ...base, workgroupIds: Array(100).fill(WORKGROUP).join(",") }).success).toBe(true);
    expect(electorateQuerySchema.safeParse({ ...base, workgroupIds: Array(101).fill(WORKGROUP).join(",") }).success).toBe(false);
    expect(electorateQuerySchema.safeParse({ ...base, kind: "poll" }).success).toBe(false);
  });

  it("reads recusal and the form's beneficiaries", () => {
    const base = { communityId: COMMUNITY, kind: "task" };
    expect(electorateQuerySchema.parse(base).recuseBeneficiaries).toBeUndefined();
    expect(electorateQuerySchema.parse(base).beneficiaries).toEqual([]);
    expect(electorateQuerySchema.parse({ ...base, recuseBeneficiaries: "true", beneficiaries: "addr_ann,addr_bo" }))
      .toMatchObject({ recuseBeneficiaries: true, beneficiaries: ["addr_ann", "addr_bo"] });
    expect(electorateQuerySchema.parse({ ...base, recuseBeneficiaries: "false", beneficiaries: ",addr_ann," }).beneficiaries)
      .toEqual(["addr_ann"]);
    expect(electorateQuerySchema.safeParse({ ...base, recuseBeneficiaries: "yes" }).success).toBe(false);
    expect(electorateQuerySchema.safeParse({ ...base, beneficiaries: Array(20).fill("addr").join(",") }).success).toBe(true);
    expect(electorateQuerySchema.safeParse({ ...base, beneficiaries: Array(21).fill("addr").join(",") }).success).toBe(false);
    expect(electorateQuerySchema.safeParse({ ...base, beneficiaries: "a".repeat(201) }).success).toBe(false);
  });

  it("validates a ballot request and a signed ballot", () => {
    expect(ballotRequestSchema.safeParse({ choice: "agree" }).success).toBe(true);
    expect(ballotRequestSchema.safeParse({ choice: "block", reason: "Too expensive" }).success).toBe(true);
    expect(ballotRequestSchema.safeParse({ choice: "maybe" }).success).toBe(false);
    // The reason is bounded loosely here (characters); the exact limit is checked on the normalized text.
    expect(ballotRequestSchema.safeParse({ choice: "block", reason: "x".repeat(MAX_VOTE_REASON * 2) }).success).toBe(true);
    expect(ballotRequestSchema.safeParse({ choice: "block", reason: "x".repeat(MAX_VOTE_REASON * 2 + 1) }).success).toBe(false);

    const vote = { choice: "yes", signedAt: "2026-09-29T10:00:00.000Z", key: "a4010103272006", signature: "845846A201" };
    expect(castVoteSchema.safeParse(vote).success).toBe(true);
    expect(castVoteSchema.safeParse({ ...vote, signedAt: "2026-09-29" }).success).toBe(false);
    expect(castVoteSchema.safeParse({ ...vote, signedAt: "2026-09-29T10:00:00+02:00" }).success).toBe(false);
    expect(castVoteSchema.safeParse({ ...vote, key: "xyz" }).success).toBe(false);
    expect(castVoteSchema.safeParse({ ...vote, key: "" }).success).toBe(false);
    expect(castVoteSchema.safeParse({ ...vote, signature: "" }).success).toBe(false);
    expect(castVoteSchema.safeParse({ ...vote, key: "a".repeat(1001) }).success).toBe(false);
    expect(castVoteSchema.safeParse({ ...vote, signature: "a".repeat(4001) }).success).toBe(false);
    expect(castVoteSchema.safeParse({ choice: "yes", key: vote.key, signature: vote.signature }).success).toBe(false);
  });

  it("trims the reason of an ended proposal", () => {
    expect(endProposalSchema.parse({})).toEqual({});
    expect(endProposalSchema.parse({ reason: "  Duplicate  " })).toEqual({ reason: "Duplicate" });
    expect(endProposalSchema.safeParse({ reason: "x".repeat(501) }).success).toBe(false);
  });

  it("takes a numeric Discord channel id for governance announcements", () => {
    expect(setGovernanceDiscordChannelSchema.parse({ communityId: COMMUNITY, channelId: " 123456789012345678 " }))
      .toEqual({ communityId: COMMUNITY, channelId: "123456789012345678" });
    expect(setGovernanceDiscordChannelSchema.safeParse({ communityId: COMMUNITY, channelId: "not-a-id" }).success).toBe(false);
    expect(setGovernanceDiscordChannelSchema.safeParse({ communityId: COMMUNITY }).success).toBe(false);
    expect(setGovernanceDiscordChannelSchema.safeParse({ communityId: "demo", channelId: "1" }).success).toBe(false);
    expect(setGovernanceDiscordChannelSchema.safeParse({ channelId: "1" }).success).toBe(false);

    const hook = "https://discord.com/api/webhooks/123456789/AbC-dEf_123";
    expect(setTreasuryDiscordDestinationSchema.parse({ treasuryId: TREASURY, url: ` ${hook} ` }))
      .toEqual({ treasuryId: TREASURY, url: hook });
    expect(setTreasuryDiscordDestinationSchema.parse({ treasuryId: TREASURY, channelId: " 99 " }))
      .toEqual({ treasuryId: TREASURY, channelId: "99" });
    expect(setTreasuryDiscordDestinationSchema.safeParse({ treasuryId: TREASURY }).success).toBe(false);
    expect(setTreasuryDiscordDestinationSchema.safeParse({ treasuryId: TREASURY, url: hook, channelId: "1" }).success)
      .toBe(false);
  });
});

describe("funding schemas", () => {
  it("normalises a funding source: trimmed name, empty link as none", () => {
    expect(fundingSourceSchema.parse({ communityId: COMMUNITY, name: "  Catalyst  ", url: "" })).toEqual({ communityId: COMMUNITY, name: "Catalyst", url: null });
    expect(fundingSourceSchema.parse({ communityId: COMMUNITY, name: "Catalyst", url: null, description: null }))
      .toEqual({ communityId: COMMUNITY, name: "Catalyst", url: null, description: null });
    expect(fundingSourceSchema.parse({ communityId: COMMUNITY, name: "Catalyst", url: " HTTPS://projectcatalyst.io " }).url).toBe("HTTPS://projectcatalyst.io");
    expect(fundingSourceSchema.safeParse({ communityId: COMMUNITY, name: "Catalyst", url: "projectcatalyst.io" }).success).toBe(false);
    expect(fundingSourceSchema.safeParse({ communityId: COMMUNITY, name: "Catalyst", url: "https://a b" }).success).toBe(false);
    expect(fundingSourceSchema.safeParse({ communityId: COMMUNITY, name: "n".repeat(81) }).success).toBe(false);
    expect(fundingSourceSchema.safeParse({ communityId: COMMUNITY, name: " " }).success).toBe(false);
    // A patch changes any subset, and cannot move the source to another community.
    expect(patchFundingSourceSchema.parse({})).toEqual({});
    expect(patchFundingSourceSchema.parse({ name: " Fund 14 ", communityId: COMMUNITY })).toEqual({ name: "Fund 14" });
  });

  const commitment = (over: Record<string, unknown>) => fundingCommitmentSchema.safeParse({ sourceId: SOURCE, name: "Fund 14", ...over });
  const ada = [{ unit: "lovelace", amount: "20000" }];

  it("accepts a one-off, a recurring and a schedule commitment", () => {
    const oneOff = commitment({ kind: "one_off", amounts: [{ unit: " LOVELACE ", amount: " 211800.72389063 " }] });
    expect(oneOff.success && oneOff.data.amounts).toEqual([{ unit: "lovelace", amount: "211800.72389063" }]);
    expect(commitment({ kind: "one_off", amounts: ada, startsOn: "2026-05" }).success).toBe(true);
    expect(commitment({ kind: "recurring", cadence: "monthly", startsOn: "2026-05", endsOn: "2026-05", amounts: ada }).success).toBe(true);
    expect(commitment({ kind: "recurring", cadence: "quarterly", startsOn: "2026-04", endsOn: null, amounts: ada }).success).toBe(true);
    const schedule = commitment({ kind: "schedule", cadence: "quarterly" });
    expect(schedule.success && schedule.data.amounts).toEqual([]);
  });

  it("ties the cadence to the kind", () => {
    expect(messages(commitment({ kind: "one_off", cadence: "monthly", amounts: ada }))).toEqual(["A one-off commitment has no cadence"]);
    expect(messages(commitment({ kind: "recurring", startsOn: "2026-05", amounts: ada }))).toEqual(["Choose monthly or quarterly"]);
    expect(messages(commitment({ kind: "schedule", cadence: null }))).toEqual(["Choose monthly or quarterly"]);
  });

  it("requires what each kind needs and refuses what it cannot have", () => {
    expect(messages(commitment({ kind: "recurring", cadence: "monthly", amounts: ada }))).toEqual(["Choose the first month"]);
    expect(messages(commitment({ kind: "one_off", endsOn: "2026-06", amounts: ada }))).toEqual(["Only a recurring commitment has an end month"]);
    expect(messages(commitment({ kind: "one_off" }))).toEqual(["Add at least one token"]);
    expect(messages(commitment({ kind: "recurring", cadence: "monthly", startsOn: "2026-05" }))).toEqual(["Add at least one token"]);
    expect(messages(commitment({ kind: "schedule", cadence: "monthly", amounts: ada }))).toEqual(["A schedule's amounts are set per period"]);
    expect(messages(commitment({ kind: "schedule", cadence: "monthly", startsOn: "2026-05" }))).toEqual(["A schedule's amounts are set per period"]);
    expect(messages(commitment({ kind: "one_off", amounts: [...ada, { unit: "Lovelace", amount: "1" }] }))).toEqual(["List each token once"]);
  });

  it("orders the months and aligns a quarterly commitment to quarters", () => {
    const recurring = { kind: "recurring", amounts: ada };
    expect(messages(commitment({ ...recurring, cadence: "monthly", startsOn: "2026-05", endsOn: "2026-04" }))).toEqual(["The last month comes before the first"]);
    expect(messages(commitment({ ...recurring, cadence: "quarterly", startsOn: "2026-05" }))).toEqual(["Quarterly periods start in January, April, July or October"]);
    expect(messages(commitment({ ...recurring, cadence: "quarterly", startsOn: "2026-04", endsOn: "2026-12" }))).toEqual(["Quarterly periods start in January, April, July or October"]);
    for (const month of ["2026-01", "2026-04", "2026-07", "2026-10"]) {
      expect(commitment({ ...recurring, cadence: "quarterly", startsOn: month }).success, month).toBe(true);
    }
    expect(commitment({ ...recurring, cadence: "monthly", startsOn: "2026-13" }).success).toBe(false);
    expect(commitment({ ...recurring, cadence: "monthly", startsOn: "2026-5" }).success).toBe(false);
  });

  it("takes planned amounts as plain positive decimals of a known unit shape", () => {
    const amount = (row: unknown) => commitment({ kind: "one_off", amounts: [row] });
    expect(amount({ unit: ASSET_UNIT.toUpperCase(), amount: "1" }).success).toBe(true);
    expect(messages(amount({ unit: "lovelace", amount: "0" }))).toContain("Amounts must be above zero");
    expect(messages(amount({ unit: "lovelace", amount: "0.000" }))).toContain("Amounts must be above zero");
    expect(amount({ unit: "lovelace", amount: "0.001" }).success).toBe(true);
    for (const bad of ["1,5", "-1", "1e3", ".5", "5.", ""]) expect(amount({ unit: "lovelace", amount: bad }).success, bad).toBe(false);
    for (const unit of ["ADA", "", "a".repeat(55), "g".repeat(56)]) expect(amount({ unit, amount: "1" }).success, unit).toBe(false);
    expect(commitment({ kind: "one_off", amounts: Array.from({ length: 21 }, (_, i) => ({ unit: `${"a".repeat(56)}${String(i).padStart(2, "0")}`, amount: "1" })) }).success).toBe(false);
  });

  it("patches a commitment: amounts, when sent, are a full non-empty distinct list", () => {
    expect(patchFundingCommitmentSchema.parse({})).toEqual({});
    expect(patchFundingCommitmentSchema.parse({ name: " Fund 15 ", url: "", endsOn: null })).toEqual({ name: "Fund 15", url: null, endsOn: null });
    expect(patchFundingCommitmentSchema.safeParse({ amounts: ada }).success).toBe(true);
    expect(messages(patchFundingCommitmentSchema.safeParse({ amounts: [] }))).toEqual(["Add at least one token"]);
    expect(messages(patchFundingCommitmentSchema.safeParse({ amounts: [...ada, ...ada] }))).toEqual(["List each token once"]);
    expect(patchFundingCommitmentSchema.safeParse({ startsOn: "May 2026" }).success).toBe(false);
  });

  it("takes a schedule with each month once and amounts in every period", () => {
    const period = (month: string) => ({ month, amounts: ada });
    expect(fundingScheduleSchema.safeParse({ periods: [] }).success).toBe(true);
    expect(fundingScheduleSchema.safeParse({ periods: [period("2026-01"), period("2026-04")] }).success).toBe(true);
    expect(messages(fundingScheduleSchema.safeParse({ periods: [period("2026-01"), period("2026-01")] }))).toEqual(["Each month appears once"]);
    expect(messages(fundingScheduleSchema.safeParse({ periods: [{ month: "2026-01", amounts: [] }] }))).toEqual(["Add at least one token"]);
    expect(fundingScheduleSchema.safeParse({ periods: [period("2026-1")] }).success).toBe(false);
    expect(fundingScheduleSchema.safeParse({}).success).toBe(false);
  });

  it("tags an inflow with a commitment only together with its source", () => {
    const details = { txHash: TX_HASH, incomingType: "contribution", requiresReconciliation: false };
    const commitmentId = "60000000-0000-4000-8000-000000000001";
    expect(incomingDetailsSchema.safeParse(details).success).toBe(true);
    expect(incomingDetailsSchema.safeParse({ ...details, fundingSourceId: SOURCE }).success).toBe(true);
    expect(incomingDetailsSchema.safeParse({ ...details, fundingSourceId: SOURCE, fundingCommitmentId: commitmentId }).success).toBe(true);
    expect(incomingDetailsSchema.safeParse({ ...details, fundingSourceId: null, fundingCommitmentId: null }).success).toBe(true);
    expect(messages(incomingDetailsSchema.safeParse({ ...details, fundingCommitmentId: commitmentId }))).toEqual(["Choose the funding source of the commitment"]);
    expect(incomingDetailsSchema.safeParse({ ...details, fundingSourceId: null, fundingCommitmentId: commitmentId }).success).toBe(false);
    expect(incomingDetailsSchema.safeParse({ ...details, incomingType: "gift" }).success).toBe(false);
    expect(incomingDetailsSchema.safeParse({ ...details, txHash: "abc" }).success).toBe(false);
    expect(incomingDetailsSchema.parse({ ...details, note: "  from the fund  " }).note).toBe("from the fund");
  });
});

describe("chain import schemas", () => {
  it("maps a record's workgroup name only to a chosen workgroup", () => {
    const base = { communityId: COMMUNITY, name: " Dev Guild " };
    expect(chainImportWorkgroupSchema.parse({ ...base, action: "create" })).toEqual({ communityId: COMMUNITY, name: "Dev Guild", action: "create" });
    expect(chainImportWorkgroupSchema.safeParse({ ...base, action: "map", workgroupId: WORKGROUP }).success).toBe(true);
    expect(messages(chainImportWorkgroupSchema.safeParse({ ...base, action: "map" }))).toEqual(["Choose a workgroup"]);
    expect(chainImportWorkgroupSchema.safeParse({ ...base, action: "map", workgroupId: "dev" }).success).toBe(false);
    expect(chainImportWorkgroupSchema.safeParse({ ...base, action: "rename" }).success).toBe(false);
    // The name is one metadatum: at most 64 characters.
    expect(chainImportWorkgroupSchema.safeParse({ ...base, name: "n".repeat(64), action: "create" }).success).toBe(true);
    expect(chainImportWorkgroupSchema.safeParse({ ...base, name: "n".repeat(65), action: "create" }).success).toBe(false);
    expect(chainImportWorkgroupSchema.safeParse({ ...base, name: "  ", action: "create" }).success).toBe(false);
  });

  it("resolves a blocked transaction by hash, with positive whole task numbers", () => {
    expect(chainImportResolveSchema.safeParse({ txHash: TX_HASH, action: "retry" }).success).toBe(true);
    expect(chainImportResolveSchema.safeParse({ txHash: TX_HASH.toUpperCase(), action: "ignore" }).success).toBe(true);
    expect(chainImportResolveSchema.parse({ txHash: TX_HASH, action: "new_number", chainNumbers: [1, 42] }).chainNumbers).toEqual([1, 42]);
    for (const chainNumbers of [[0], [-1], [1.5], ["1"]]) {
      expect(chainImportResolveSchema.safeParse({ txHash: TX_HASH, action: "new_number", chainNumbers }).success).toBe(false);
    }
    expect(chainImportResolveSchema.safeParse({ txHash: TX_HASH, action: "new_number", chainNumbers: Array(201).fill(1) }).success).toBe(false);
    expect(chainImportResolveSchema.safeParse({ txHash: TX_HASH, action: "delete" }).success).toBe(false);
    for (const txHash of [TX_HASH.slice(1), `${TX_HASH}ab`, "g".repeat(64), ""]) {
      expect(chainImportResolveSchema.safeParse({ txHash, action: "retry" }).success).toBe(false);
    }
  });
});

describe("previous-wallet history schemas", () => {
  const walletId = "80000000-0000-4000-8000-000000000001";

  it("takes a previous wallet's name and, optionally, a Shelley address", () => {
    expect(createLegacyWalletSchema.parse({ communityId: COMMUNITY, name: " Old wallet " })).toEqual({ communityId: COMMUNITY, name: "Old wallet" });
    expect(createLegacyWalletSchema.safeParse({ communityId: COMMUNITY, name: "Old wallet", address: ADDR }).success).toBe(true);
    expect(createLegacyWalletSchema.safeParse({ communityId: COMMUNITY, name: "Old wallet", address: null }).success).toBe(true);
    expect(createLegacyWalletSchema.safeParse({ communityId: COMMUNITY, name: "Old wallet", address: "addr_test1garbage" }).success).toBe(false);
    expect(createLegacyWalletSchema.safeParse({ communityId: COMMUNITY, name: "Old wallet", address: "" }).success).toBe(false);
    expect(createLegacyWalletSchema.safeParse({ communityId: COMMUNITY, name: "n".repeat(65) }).success).toBe(false);
    expect(createLegacyWalletSchema.safeParse({ communityId: COMMUNITY, name: " " }).success).toBe(false);
    expect(patchLegacyWalletSchema.parse({})).toEqual({});
    expect(patchLegacyWalletSchema.parse({ address: null })).toEqual({ address: null });
    expect(patchLegacyWalletSchema.safeParse({ name: "" }).success).toBe(false);
  });

  it("settles a CSV workgroup name like the chain import, with an optional display name", () => {
    const base = { communityId: COMMUNITY, name: "dev guild" };
    expect(legacyWorkgroupSchema.parse({ ...base, action: "create", displayName: " Dev Guild " }))
      .toEqual({ ...base, action: "create", displayName: "Dev Guild" });
    expect(legacyWorkgroupSchema.safeParse({ ...base, action: "map", workgroupId: WORKGROUP }).success).toBe(true);
    expect(messages(legacyWorkgroupSchema.safeParse({ ...base, action: "map" }))).toEqual(["Choose a workgroup"]);
    expect(legacyWorkgroupSchema.safeParse({ ...base, action: "create", displayName: "n".repeat(101) }).success).toBe(false);
    expect(legacyWorkgroupSchema.safeParse({ ...base, action: "create", displayName: " " }).success).toBe(false);
  });

  it("bounds an uploaded CSV and defaults its options", () => {
    const upload = { communityId: COMMUNITY, legacyWalletId: walletId, fileName: "payments.csv", csv: "userId,ADA\n" };
    expect(legacyUploadSchema.parse(upload)).toEqual({ ...upload, tickerUnits: {}, includeDuplicates: false });
    expect(legacyUploadSchema.safeParse({ ...upload, csv: "" }).success).toBe(false);
    expect(legacyUploadSchema.safeParse({ ...upload, csv: "x".repeat(LEGACY_MAX_CSV_CHARS) }).success).toBe(true);
    expect(messages(legacyUploadSchema.safeParse({ ...upload, csv: "x".repeat(LEGACY_MAX_CSV_CHARS + 1) })))
      .toEqual(["The file is larger than 1 MB. Split it into several files."]);
    expect(legacyUploadSchema.safeParse({ ...upload, fileName: " " }).success).toBe(false);
    expect(legacyUploadSchema.safeParse({ ...upload, replaceImportId: null, includeDuplicates: true }).success).toBe(true);
    expect(legacyUploadSchema.safeParse({ ...upload, replaceImportId: "latest" }).success).toBe(false);
  });

  it("takes manual ticker choices as native asset units only", () => {
    const upload = { communityId: COMMUNITY, legacyWalletId: walletId, fileName: "payments.csv", csv: "userId,AGIX\n" };
    expect(legacyUploadSchema.parse({ ...upload, tickerUnits: { AGIX: ASSET_UNIT } }).tickerUnits).toEqual({ AGIX: ASSET_UNIT });
    // ADA is never a manual choice, and units are stored lowercase.
    expect(legacyUploadSchema.safeParse({ ...upload, tickerUnits: { ADA: "lovelace" } }).success).toBe(false);
    expect(legacyUploadSchema.safeParse({ ...upload, tickerUnits: { AGIX: ASSET_UNIT.toUpperCase() } }).success).toBe(false);
    expect(legacyUploadSchema.safeParse({ ...upload, tickerUnits: { AGIX: "a".repeat(55) } }).success).toBe(false);
    expect(legacyUploadSchema.safeParse({ ...upload, tickerUnits: { ["T".repeat(33)]: ASSET_UNIT } }).success).toBe(false);
    const many = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`T${i}`, ASSET_UNIT]));
    expect(legacyUploadSchema.safeParse({ ...upload, tickerUnits: many(LEGACY_MAX_TICKERS) }).success).toBe(true);
    expect(messages(legacyUploadSchema.safeParse({ ...upload, tickerUnits: many(LEGACY_MAX_TICKERS + 1) }))).toEqual(["Too many token choices"]);
  });

  it("reads the row offset from the query string", () => {
    expect(legacyRowsQuerySchema.parse({ communityId: COMMUNITY })).toEqual({ communityId: COMMUNITY, offset: 0 });
    expect(legacyRowsQuerySchema.parse({ communityId: COMMUNITY, walletId, offset: "200" })).toEqual({ communityId: COMMUNITY, walletId, offset: 200 });
    for (const offset of ["-1", "1.5", "abc", "1000001"]) {
      expect(legacyRowsQuerySchema.safeParse({ communityId: COMMUNITY, offset }).success, offset).toBe(false);
    }
    expect(legacyRowsQuerySchema.safeParse({ communityId: COMMUNITY, importId: "latest" }).success).toBe(false);
  });
});

describe("agent API OAuth schemas", () => {
  it("takes the consent decision as a real boolean with optional narrowed scopes", () => {
    expect(oauthDecisionSchema.parse({ request: "handle.mac", approved: true })).toEqual({ request: "handle.mac", approved: true });
    expect(oauthDecisionSchema.parse({ request: "handle.mac", approved: false, scopes: [] }).scopes).toEqual([]);
    expect(oauthDecisionSchema.safeParse({ request: "handle.mac", approved: "true" }).success).toBe(false);
    expect(oauthDecisionSchema.safeParse({ request: "handle.mac" }).success).toBe(false);
    expect(oauthDecisionSchema.safeParse({ request: "", approved: true }).success).toBe(false);
    expect(oauthDecisionSchema.safeParse({ request: "x".repeat(8001), approved: true }).success).toBe(false);
    expect(oauthDecisionSchema.safeParse({ request: "h", approved: true, scopes: Array(21).fill("communities:read") }).success).toBe(false);
    expect(oauthDecisionSchema.safeParse({ request: "h", approved: true, scopes: ["s".repeat(101)] }).success).toBe(false);
    expect(oauthRequestQuerySchema.safeParse({}).success).toBe(false);
  });
});

describe("query-string coercion", () => {
  it("reads the network of a tx status query as 0 or 1", () => {
    expect(txStatusQuerySchema.parse({ hash: TX_HASH, network: "0" })).toEqual({ hash: TX_HASH, network: 0 });
    expect(txStatusQuerySchema.parse({ hash: TX_HASH, network: "1" }).network).toBe(1);
    expect(txStatusQuerySchema.safeParse({ hash: TX_HASH, network: "2" }).success).toBe(false);
    expect(txStatusQuerySchema.safeParse({ hash: TX_HASH, network: "mainnet" }).success).toBe(false);
    expect(txStatusQuerySchema.safeParse({ hash: TX_HASH }).success).toBe(false);
    expect(txStatusQuerySchema.safeParse({ hash: "abc", network: "1" }).success).toBe(false);
  });

  it("reads the GitHub installation id as a positive integer and needs a state", () => {
    expect(githubSetupQuerySchema.parse({ installation_id: "12345", state: "s.mac" })).toEqual({ installation_id: 12345, state: "s.mac" });
    for (const installation_id of ["0", "-5", "1.5", "abc"]) {
      expect(githubSetupQuerySchema.safeParse({ installation_id, state: "s" }).success, installation_id).toBe(false);
    }
    expect(githubSetupQuerySchema.safeParse({ installation_id: "1" }).success).toBe(false);
    expect(githubSetupQuerySchema.safeParse({ installation_id: "1", state: "" }).success).toBe(false);
  });
});

describe("payment and payout builds", () => {
  const treasuryId = "40000000-0000-4000-8000-000000000001";
  const payment = { treasuryId, budgetMonth: "2026-09", recipients: [{ address: ADDR, amounts: { lovelace: "12.5" } }] };

  it("validates a manual payment", () => {
    expect(buildPaymentSchema.safeParse(payment).success).toBe(true);
    expect(buildPaymentSchema.parse({ ...payment, memo: "  Hosting  " }).memo).toBe("Hosting");
    expect(buildPaymentSchema.safeParse({ ...payment, memo: "m".repeat(MAX_PAYMENT_MEMO_BYTES) }).success).toBe(true);
    expect(messages(buildPaymentSchema.safeParse({ ...payment, memo: "m".repeat(MAX_PAYMENT_MEMO_BYTES + 1) })))
      .toEqual([`Memo must be at most ${MAX_PAYMENT_MEMO_BYTES} characters`]);
    expect(messages(buildPaymentSchema.safeParse({ ...payment, recipients: [] }))).toEqual(["Add at least one recipient"]);
    expect(messages(buildPaymentSchema.safeParse({ ...payment, recipients: Array(MAX_PAYOUT_CONTRIBUTORS + 1).fill(payment.recipients[0]) })))
      .toEqual([`At most ${MAX_PAYOUT_CONTRIBUTORS} recipients per payment`]);
    expect(buildPaymentSchema.safeParse({ ...payment, budgetMonth: "2026-13" }).success).toBe(false);
    expect(buildPaymentSchema.safeParse({ treasuryId, recipients: payment.recipients }).success).toBe(false);
    // The proposal a payment carries out (cited on-chain): a row id or nothing.
    expect(buildPaymentSchema.safeParse({ ...payment, proposalId: treasuryId }).success).toBe(true);
    expect(buildPaymentSchema.safeParse({ ...payment, proposalId: "7" }).success).toBe(false);
    expect(buildPaymentSchema.safeParse({ ...payment, recipients: [{ address: "addr_test1garbage", amounts: { lovelace: "1" } }] }).success).toBe(false);
    for (const amount of ["-1", "1e3", "1,5", ".5", ""]) {
      expect(buildPaymentSchema.safeParse({ ...payment, recipients: [{ address: ADDR, amounts: { lovelace: amount } }] }).success, amount).toBe(false);
    }
    const tokens = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`unit${i}`, "1"]));
    expect(buildPaymentSchema.safeParse({ ...payment, recipients: [{ address: ADDR, amounts: tokens(50) }] }).success).toBe(true);
    expect(messages(buildPaymentSchema.safeParse({ ...payment, recipients: [{ address: ADDR, amounts: tokens(51) }] })))
      .toEqual(["Too many tokens for one recipient"]);
  });

  it("validates a payout build", () => {
    const taskId = "30000000-0000-4000-8000-000000000001";
    expect(buildPayoutSchema.safeParse({ treasuryId, taskIds: [taskId] }).success).toBe(true);
    expect(buildPayoutSchema.safeParse({ treasuryId, taskIds: [] }).success).toBe(false);
    expect(buildPayoutSchema.safeParse({ treasuryId, taskIds: ["42"] }).success).toBe(false);
    expect(buildPayoutSchema.safeParse({ treasuryId, taskIds: Array(201).fill(taskId) }).success).toBe(false);
    const connections = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`FIELD${i}`, ASSET_UNIT]));
    expect(buildPayoutSchema.safeParse({ treasuryId, taskIds: [taskId], connections: connections(100) }).success).toBe(true);
    expect(messages(buildPayoutSchema.safeParse({ treasuryId, taskIds: [taskId], connections: connections(101) }))).toEqual(["Too many token connections"]);
    expect(buildPayoutSchema.safeParse({ treasuryId, taskIds: [taskId], connections: { ["F".repeat(65)]: ASSET_UNIT } }).success).toBe(false);
  });

  it("matches an incoming transaction against a whole base-unit amount", () => {
    expect(reconcileMatchSchema.safeParse({ txHash: TX_HASH, amount: "5000000" }).success).toBe(true);
    expect(reconcileMatchSchema.safeParse({ txHash: TX_HASH, amount: "5000000", payoutId: null }).success).toBe(true);
    for (const amount of ["5.5", "-1", "", "1".repeat(31)]) {
      expect(reconcileMatchSchema.safeParse({ txHash: TX_HASH, amount }).success, amount).toBe(false);
    }
    expect(reconcileMatchSchema.safeParse({ txHash: TX_HASH, amount: 5 }).success).toBe(false);
  });
});

describe("other guarded writes", () => {
  it("patches a linked meeting with at least one in-range field", () => {
    expect(patchMeetingLinkSchema.safeParse({ title: "Weekly sync" }).success).toBe(true);
    expect(patchMeetingLinkSchema.safeParse({ durationMinutes: 90, minMinutes: 0 }).success).toBe(true);
    expect(messages(patchMeetingLinkSchema.safeParse({}))).toEqual(["Nothing to update"]);
    expect(patchMeetingLinkSchema.safeParse({ durationMinutes: 0 }).success).toBe(false);
    expect(patchMeetingLinkSchema.safeParse({ durationMinutes: 24 * 60 + 1 }).success).toBe(false);
    expect(patchMeetingLinkSchema.safeParse({ amounts: {} }).success).toBe(false);
  });

  it("needs a written reason to reset a budget", () => {
    const reset = { workgroupId: WORKGROUP, expectedRevision: 3, confirmation: "Dev Guild", reason: "  Wrong token  " };
    expect(budgetResetSchema.parse(reset).reason).toBe("Wrong token");
    expect(budgetResetSchema.safeParse({ ...reset, reason: "   " }).success).toBe(false);
    expect(budgetResetSchema.safeParse({ ...reset, confirmation: "" }).success).toBe(false);
    expect(budgetResetSchema.safeParse({ ...reset, expectedRevision: -1 }).success).toBe(false);
    expect(budgetResetSchema.safeParse({ ...reset, expectedRevision: 1.5 }).success).toBe(false);
  });
});
