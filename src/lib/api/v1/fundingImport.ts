// funding_schedule_preview: map a funder's CSV onto a schedule and, once every
// column and token is settled, hand back a draft. Cells are never rewritten.
// draft_confirm writes the periods.
import "server-only";

import { z } from "zod";
import type { ApiCaller } from "@/lib/api/caller";
import { HTTP_URL_RE, spendingUnit } from "@/lib/api/schemas";
import { formatQuantity } from "@/lib/assets";
import { sha256Hex } from "@/lib/auth/crypto";
import { fetchWalletAssets } from "@/lib/cardano/walletAssets";
import { asNetwork } from "@/lib/config";
import { LEGACY_MAX_CSV_CHARS } from "@/lib/constants";
import { loadAssetRegistry } from "@/lib/db/assets";
import {
  deleteAgentImportPayload, importAgentFundingSchedule, loadAgentImportPayload, storeAgentImportPayload,
} from "@/lib/db/agentImports";
import { loadFundingPeriods, loadFundingSource } from "@/lib/db/funding";
import { enforceRateLimit } from "@/lib/db/rateLimit";
import { loadCommunityTreasuries } from "@/lib/db/treasuries";
import type { FundingAmount } from "@/lib/db/types";
import { BadRequestError, ConflictError, DomainError, NotFoundError } from "@/lib/errors";
import { requireFundingCommitmentAdmin, resolveFundingTokens } from "@/lib/funding/access";
import { toFundingAmounts } from "@/lib/funding/amounts";
import { fundingTokenOptions, type FundingTokenOption } from "@/lib/funding/display";
import {
  amountColumns, buildSchedule, mergeSchedulePeriods, readScheduleCsv, suggestAmountUnits, suggestDateColumn,
  type ScheduleIssue,
} from "@/lib/funding/schedule";
import { canonicalJson } from "@/lib/governance/rules";
import { mintDraftToken, type VerifiedDraft } from "@/lib/mcp/draftToken";
import { routes } from "@/lib/routes";
import { defineEndpoint } from "./endpoint";
import { requireImportAdmin } from "./importAdmin";
import { appLink, communityInput } from "./shared";

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "A month is YYYY-MM");

const fundingInput = z.object({
  community: communityInput,
  csv: z.string().min(1).max(LEGACY_MAX_CSV_CHARS).describe(
    "The CSV exactly as the user gave it. Do not rewrite amounts or dates; map columns instead.",
  ),
  cadence: z.enum(["monthly", "quarterly"]),
  dateColumn: z.number().int().min(0).max(50).nullable().optional()
    .describe("Column index of the month. Null means the rows are consecutive periods from startMonth. Omit to be offered a guess."),
  startMonth: month.optional().describe("First row's month when there is no date column"),
  columns: z.array(z.object({
    index: z.number().int().min(0).max(50),
    unit: spendingUnit.describe("lovelace, or the policy id + asset name in hex. Never invent one."),
  })).max(20).optional(),
  skip: z.array(z.number().int().min(0).max(50)).max(50).default([]),
  sourceId: z.string().uuid().optional().describe("An existing funding source"),
  sourceName: z.string().trim().min(1).max(80).optional().describe("Name of a funding source to create"),
  sourceDescription: z.string().trim().max(500).optional(),
  sourceUrl: z.string().trim().max(500).regex(HTTP_URL_RE, "Use a link starting with http:// or https://").optional(),
  commitmentId: z.string().uuid().optional().describe("An existing schedule. Mapped tokens replace that token's periods; other tokens stay."),
  commitmentName: z.string().trim().min(1).max(120).optional().describe("Name of a schedule to create"),
}).refine((v) => !(v.sourceId && v.sourceName), { message: "Give a funding source's id or a name to create, not both" })
  .refine((v) => !(v.commitmentId && v.commitmentName), { message: "Give a schedule's id or a name to create, not both" })
  .refine((v) => !v.sourceUrl || v.sourceName, { message: "A link belongs to the funding source being created" })
  .refine((v) => !v.sourceDescription || v.sourceName, { message: "A description belongs to the funding source being created" });

interface StoredSchedule {
  dateColumn: number | null;
  startMonth: string | null;
  cadence: "monthly" | "quarterly";
  columns: { index: number; unit: string }[];
  skip: number[];
  sourceId: string | null;
  source: { name: string; description: string | null; url: string | null } | null;
  commitmentId: string | null;
  commitmentName: string | null;
}

const storedSchedule = z.object({
  dateColumn: z.number().nullable(),
  startMonth: z.string().nullable(),
  cadence: z.enum(["monthly", "quarterly"]),
  columns: z.array(z.object({ index: z.number(), unit: z.string() })),
  skip: z.array(z.number()),
  sourceId: z.string().nullable(),
  source: z.object({ name: z.string(), description: z.string().nullable(), url: z.string().nullable() }).nullable(),
  commitmentId: z.string().nullable(),
  commitmentName: z.string().nullable(),
});

interface Question { column: string | null; message: string }

function asQuestions(issues: ScheduleIssue[]): Question[] {
  return issues.map((issue) => ({ column: null, message: issue.line ? `Line ${issue.line}: ${issue.message}` : issue.message }));
}

async function optionList(communityId: string, withWallets: boolean): Promise<FundingTokenOption[]> {
  const registry = await loadAssetRegistry(communityId);
  const walletTokens: { unit: string; ticker: string | null; decimals: number }[] = [];
  if (withWallets) {
    const treasuries = await loadCommunityTreasuries(communityId);
    for (const treasury of treasuries) {
      try {
        const assets = await fetchWalletAssets(asNetwork(treasury.network), treasury.address);
        walletTokens.push(...assets.tokens);
      } catch {
        // A suggestion only. A unit the user names is still checked on its own.
      }
    }
  }
  return fundingTokenOptions(registry, walletTokens, [], []);
}

function scheduleFingerprint(stored: StoredSchedule, periods: { startsOn: string; amounts: FundingAmount[] }[]): string {
  const lines = periods.flatMap((period) =>
    period.amounts.map((amount) => `${period.startsOn}:${amount.unit}:${amount.amount}`),
  ).sort();
  return sha256Hex(canonicalJson({
    cadence: stored.cadence,
    source: stored.sourceId ?? stored.source,
    commitment: stored.commitmentId ?? stored.commitmentName,
    columns: [...stored.columns].sort((a, b) => a.index - b.index),
    lines,
  }));
}

async function planStored(
  communityId: string,
  wallet: string,
  csv: string,
  stored: StoredSchedule,
): Promise<{ questions: Question[]; periods: { startsOn: string; amounts: FundingAmount[] }[]; headers: string[] }> {
  const table = readScheduleCsv(csv);
  const questions = asQuestions(table.issues);
  if (table.headers.length === 0) return { questions, periods: [], headers: [] };
  if (!stored.commitmentId && stored.sourceId) {
    const source = await loadFundingSource(stored.sourceId);
    if (!source || source.community_id !== communityId) throw new NotFoundError("Funding source not found");
  }
  if (stored.dateColumn !== null && stored.dateColumn >= table.headers.length) {
    questions.push({ column: null, message: "The date column is not in this file." });
  }
  const tokens = await resolveFundingTokens(communityId, stored.columns.map((c) => c.unit));
  const built = buildSchedule(table, {
    dateColumn: stored.dateColumn,
    startMonth: stored.startMonth,
    cadence: stored.cadence,
    columns: stored.columns.map((column) => {
      const token = tokens.get(column.unit)!;
      return { index: column.index, unit: column.unit, ticker: token.ticker, decimals: token.decimals };
    }),
  });
  questions.push(...asQuestions(built.issues));

  let merged = built.periods.map((period) => ({
    month: period.month,
    amounts: period.amounts.map((amount) => ({ unit: amount.unit, amount: amount.amount })),
  }));
  if (stored.commitmentId) {
    const commitment = await requireFundingCommitmentAdmin(stored.commitmentId, wallet);
    if (commitment.community_id !== communityId) questions.push({ column: null, message: "That schedule is not in this community." });
    else if (commitment.kind !== "schedule") questions.push({ column: null, message: "That commitment is not a schedule." });
    else if (commitment.cadence !== stored.cadence) {
      questions.push({ column: null, message: `That schedule is ${commitment.cadence}, not ${stored.cadence}.` });
    } else {
      const existing = await loadFundingPeriods(stored.commitmentId);
      merged = mergeSchedulePeriods(
        existing.map((period) => ({
          month: period.starts_on.slice(0, 7),
          amounts: period.amounts.map((amount) => ({
            unit: amount.unit,
            amount: formatQuantity(BigInt(amount.amount), amount.decimals),
          })),
        })),
        merged,
        stored.columns.map((c) => c.unit),
      );
    }
  }
  const units = [...new Set(merged.flatMap((period) => period.amounts.map((amount) => amount.unit)))];
  const allTokens = units.length === stored.columns.length && units.every((unit) => tokens.has(unit))
    ? tokens
    : await resolveFundingTokens(communityId, units);
  let periods: { startsOn: string; amounts: FundingAmount[] }[] = [];
  if (questions.length === 0 && merged.length > 0) {
    try {
      periods = merged.map((period) => ({
        startsOn: `${period.month}-01`,
        amounts: toFundingAmounts(period.amounts, allTokens),
      }));
    } catch (err) {
      if (err instanceof DomainError) questions.push({ column: null, message: err.message });
      else throw err;
    }
  }
  return { questions, periods, headers: table.headers };
}

export const previewFundingSchedule = defineEndpoint({
  scope: "imports:write",
  input: fundingInput,
  async run(caller, input) {
    const community = await requireImportAdmin(caller, input.community);
    await enforceRateLimit("fundingImport", caller.wallet);
    const table = readScheduleCsv(input.csv);
    const url = appLink(routes.funding(community.slug));
    const questions: Question[] = asQuestions(table.issues);
    if (table.headers.length === 0) return { ready: false, headers: table.headers, questions, url };

    let dateColumn: number | null;
    if (input.dateColumn === undefined) {
      const guessed = suggestDateColumn(table);
      if (guessed === null) {
        questions.push({
          column: null,
          message: "Which column holds the month? Give its index, or dateColumn null and startMonth (YYYY-MM) when the rows are consecutive periods.",
        });
        dateColumn = null;
      } else dateColumn = guessed;
    } else if (input.dateColumn !== null && input.dateColumn >= table.headers.length) {
      questions.push({ column: null, message: "The date column is not in this file." });
      dateColumn = null;
    } else dateColumn = input.dateColumn;

    const skipped = new Set(input.skip);
    const explicit = new Map((input.columns ?? []).map((column) => [column.index, column.unit]));
    let options = await optionList(community.id, false);
    let guessedUnits = suggestAmountUnits(table, dateColumn, options);
    const pending = amountColumns(table, dateColumn).filter((index) =>
      !skipped.has(index) && !explicit.has(index) && !guessedUnits[index]);
    if (pending.length > 0) {
      options = await optionList(community.id, true);
      guessedUnits = suggestAmountUnits(table, dateColumn, options);
    }
    const columns: { index: number; unit: string }[] = [];
    for (const index of amountColumns(table, dateColumn)) {
      if (skipped.has(index)) continue;
      const unit = explicit.get(index) || guessedUnits[index] || "";
      if (!unit) {
        questions.push({
          column: table.headers[index] ?? null,
          message: `Which token is "${table.headers[index]}"? Give its unit (lovelace, or the policy id followed by the asset name in hex), or skip the column. Do not guess.`,
        });
      } else columns.push({ index, unit });
    }
    for (const [index, unit] of explicit) {
      if (!columns.some((column) => column.index === index) && !skipped.has(index)) columns.push({ index, unit });
    }

    let sourceId: string | null = null;
    let source: StoredSchedule["source"] = null;
    let commitmentId: string | null = null;
    let commitmentName: string | null = null;
    if (input.commitmentId) commitmentId = input.commitmentId;
    else if (input.commitmentName) commitmentName = input.commitmentName.trim();
    else questions.push({ column: null, message: "Name the schedule (commitmentName), or give commitmentId of an existing one." });
    if (!commitmentId) {
      if (input.sourceId) sourceId = input.sourceId;
      else if (input.sourceName) {
        source = {
          name: input.sourceName.trim(),
          description: input.sourceDescription?.trim() || null,
          url: input.sourceUrl ?? null,
        };
      } else questions.push({ column: null, message: "Which funding source is this schedule for? Give sourceName to create one, or sourceId of one that exists." });
    }

    const stored: StoredSchedule = {
      dateColumn,
      startMonth: input.startMonth ?? null,
      cadence: input.cadence,
      columns,
      skip: input.skip,
      sourceId,
      source,
      commitmentId,
      commitmentName,
    };
    let periods: { startsOn: string; amounts: FundingAmount[] }[] = [];
    if (columns.length > 0) {
      try {
        const planned = await planStored(community.id, caller.wallet, input.csv, stored);
        questions.push(...planned.questions.filter((q) => !questions.some((have) => have.message === q.message)));
        if (planned.questions.length === 0) periods = planned.periods;
      } catch (err) {
        if (err instanceof BadRequestError || err instanceof DomainError || err instanceof NotFoundError) {
          questions.push({ column: null, message: err.message });
        } else throw err;
      }
    }

    const tokenByUnit = new Map(options.map((option) => [option.unit, option]));
    const totals = new Map<string, { amount: bigint; ticker: string; decimals: number }>();
    for (const period of periods) {
      for (const amount of period.amounts) {
        const have = totals.get(amount.unit);
        totals.set(amount.unit, {
          amount: (have?.amount ?? 0n) + BigInt(amount.amount),
          ticker: amount.asset_label ?? tokenByUnit.get(amount.unit)?.ticker ?? amount.unit.slice(-8),
          decimals: amount.decimals,
        });
      }
    }
    const body = {
      headers: table.headers,
      mapping: {
        dateColumn,
        startMonth: stored.startMonth,
        cadence: stored.cadence,
        columns: columns.map((column) => ({
          index: column.index,
          header: table.headers[column.index] ?? null,
          unit: column.unit,
          ticker: tokenByUnit.get(column.unit)?.ticker ?? null,
        })),
      },
      periods: periods.length,
      first: periods[0]?.startsOn.slice(0, 7) ?? null,
      last: periods.at(-1)?.startsOn.slice(0, 7) ?? null,
      totals: [...totals].map(([unit, total]) => ({
        ticker: total.ticker,
        unit,
        amount: formatQuantity(total.amount, total.decimals),
      })),
      source: sourceId ? { id: sourceId } : source ? { ...source, create: true as const } : null,
      commitment: commitmentId ? { id: commitmentId } : commitmentName ? { name: commitmentName, create: true as const } : null,
      url,
    };
    if (questions.length > 0 || periods.length === 0) {
      return { ready: false, ...body, questions: questions.slice(0, 30) };
    }
    const payload = await storeAgentImportPayload({
      communityId: community.id, wallet: caller.wallet, kind: "funding_schedule", csv: input.csv, mapping: stored,
    });
    const draft = await mintDraftToken(caller, {
      action: "funding_schedule_import",
      community: community.slug,
      request: { payloadId: payload.id },
      fingerprint: scheduleFingerprint(stored, periods),
      rulesHash: "",
    });
    return { ready: true, ...body, questions: [], draftToken: draft.token, expiresAt: draft.expiresAt };
  },
});

async function replayFundingSchedule(caller: ApiCaller, draft: VerifiedDraft, communityId: string, slug: string): Promise<object> {
  try {
    const result = await importAgentFundingSchedule({
      draftId: draft.draftId,
      communityId,
      actor: caller.wallet,
      sourceId: null,
      sourceName: null,
      sourceDescription: null,
      sourceUrl: null,
      commitmentId: null,
      commitmentName: null,
      cadence: "monthly",
      periods: [],
    });
    return { ...result, url: appLink(routes.funding(slug)) };
  } catch (err) {
    if (err instanceof ConflictError) throw new BadRequestError("This draft is not valid or has expired: preview it again");
    throw err;
  }
}

export async function confirmFundingScheduleImport(caller: ApiCaller, draft: VerifiedDraft): Promise<object> {
  const community = await requireImportAdmin(caller, draft.community);
  await enforceRateLimit("fundingImport", caller.wallet);
  const payloadId = draft.request.payloadId;
  if (typeof payloadId !== "string") throw new BadRequestError("This draft is not valid: preview it again");
  const payload = await loadAgentImportPayload(payloadId);
  if (!payload) return replayFundingSchedule(caller, draft, community.id, community.slug);
  if (payload.kind !== "funding_schedule" || payload.community_id !== community.id || payload.wallet !== caller.wallet) {
    throw new BadRequestError("This draft is not valid or has expired: preview it again");
  }
  if (Date.parse(payload.expires_at) <= Date.now()) {
    throw new BadRequestError("This draft is not valid or has expired: preview it again");
  }
  const parsed = storedSchedule.safeParse(payload.mapping);
  if (!parsed.success) throw new BadRequestError("This draft is not valid: preview it again");
  const stored = parsed.data;
  const planned = await planStored(community.id, caller.wallet, payload.csv, stored);
  if (planned.questions.length > 0 || planned.periods.length === 0 || scheduleFingerprint(stored, planned.periods) !== draft.fingerprint) {
    throw new ConflictError("The import changed since the preview. Preview it again.");
  }
  const result = await importAgentFundingSchedule({
    draftId: draft.draftId,
    communityId: community.id,
    actor: caller.wallet,
    sourceId: stored.sourceId,
    sourceName: stored.source?.name ?? null,
    sourceDescription: stored.source?.description ?? null,
    sourceUrl: stored.source?.url ?? null,
    commitmentId: stored.commitmentId,
    commitmentName: stored.commitmentName,
    cadence: stored.cadence,
    periods: planned.periods,
  });
  await deleteAgentImportPayload(payload.id);
  return { ...result, url: appLink(routes.funding(community.slug)) };
}
