"use client";

// Proposals, their electorates, ballots and history, and the community's
// governance settings. Members read all of it through RLS; other members'
// ballots only once the proposal's rules allow (after the close by default).
import { apiFetch } from "@/lib/api/client";
import type { AnchorsDueResponse, IpfsGatewayResponse } from "@/lib/api/types";
import { browserClient } from "@/lib/supabase/browser";
import { ProposalKind } from "@/lib/constants";
import {
  GOVERNANCE_COMMUNITY_SETTINGS_COLUMNS, GOVERNANCE_SETTING_CHANGE_COLUMNS, GOVERNANCE_SETTINGS_COLUMNS,
  PROPOSAL_ANCHOR_WITH_TX_COLUMNS, PROPOSAL_BUDGET_OWNER_COLUMNS, PROPOSAL_COLUMNS,
  PROPOSAL_DOCUMENT_COPY_COLUMNS, PROPOSAL_EVENT_COLUMNS, PROPOSAL_VOTE_COLUMNS, type DocumentStoreName,
  type GovernanceCommunitySettingsRow, type GovernanceSettingChangeRow, type GovernanceSettingsRow,
  type ProposalAnchorWithTx, type ProposalBudgetOwnerRow, type ProposalDocumentCopyRow, type ProposalEventRow,
  type ProposalRow, type ProposalVoteRow, type ProposalVoterRow,
} from "@/lib/db/types";
import { settingsFromRow, type GovernanceSettings } from "@/lib/governance/rules";
import { copyUrl, parseGithubLocator } from "@/lib/storage/locator";
import { useAsyncData, type AsyncData } from "./useAsyncData";

function unwrap<T>(res: { data: unknown; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return (res.data ?? []) as T;
}

/** The community's proposals, newest first. */
export function useProposals(communityId: string | null | undefined): AsyncData<ProposalRow[]> {
  return useAsyncData(communityId, async () => unwrap<ProposalRow[]>(
    await browserClient().from("proposals").select(PROPOSAL_COLUMNS)
      .eq("community_id", communityId).order("created_at", { ascending: false }),
  ));
}

export interface ProposalDetails {
  proposal: ProposalRow;
  voters: ProposalVoterRow[];
  /** Your own ballot, and everyone's once they are visible. */
  votes: ProposalVoteRow[];
  events: ProposalEventRow[];
  budgetOwners: ProposalBudgetOwnerRow[];
  /** The on-chain anchors of its steps, with their transactions (0060). */
  anchors: ProposalAnchorWithTx[];
}

export function useProposal(proposalId: string | null | undefined): AsyncData<ProposalDetails | null> {
  return useAsyncData(proposalId, async () => {
    const db = browserClient();
    const proposal = await db.from("proposals").select(PROPOSAL_COLUMNS).eq("id", proposalId).maybeSingle();
    if (proposal.error) throw new Error(proposal.error.message);
    if (!proposal.data) return null;
    const [voters, votes, events, owners, anchors] = await Promise.all([
      db.from("proposal_voters").select("proposal_id, wallet_address, recused").eq("proposal_id", proposalId),
      db.from("proposal_votes").select(PROPOSAL_VOTE_COLUMNS).eq("proposal_id", proposalId).order("updated_at"),
      db.from("proposal_events").select(PROPOSAL_EVENT_COLUMNS).eq("proposal_id", proposalId).order("occurred_at"),
      db.from("proposal_budget_owners").select(PROPOSAL_BUDGET_OWNER_COLUMNS).eq("proposal_id", proposalId),
      db.from("proposal_anchors").select(PROPOSAL_ANCHOR_WITH_TX_COLUMNS).eq("proposal_id", proposalId),
    ]);
    return {
      proposal: proposal.data as ProposalRow,
      voters: unwrap<ProposalVoterRow[]>(voters),
      votes: unwrap<ProposalVoteRow[]>(votes),
      events: unwrap<ProposalEventRow[]>(events),
      budgetOwners: unwrap<ProposalBudgetOwnerRow[]>(owners),
      anchors: unwrap<ProposalAnchorWithTx[]>(anchors),
    };
  });
}

/** The anchor steps due in the community, per proposal (what the next payout, payment or anchor transaction carries). */
export function useAnchorsDue(communityId: string | null | undefined): AsyncData<AnchorsDueResponse["due"]> {
  return useAsyncData(communityId, async () =>
    (await apiFetch<AnchorsDueResponse>("/api/proposals/anchors-due", { query: { communityId } })).due);
}

export type GovernanceSettingsByKind = Record<ProposalKind, GovernanceSettings>;

/** Every kind's settings, defaults where an admin never saved any. */
export function useGovernanceSettings(communityId: string | null | undefined): AsyncData<GovernanceSettingsByKind> {
  return useAsyncData(communityId, async () => {
    const rows = unwrap<GovernanceSettingsRow[]>(
      await browserClient().from("governance_settings").select(GOVERNANCE_SETTINGS_COLUMNS).eq("community_id", communityId),
    );
    const byKind = (kind: ProposalKind) => settingsFromRow(rows.find((row) => row.kind === kind), kind);
    return Object.fromEntries(Object.values(ProposalKind).map((kind) => [kind, byKind(kind)])) as GovernanceSettingsByKind;
  });
}

export interface TallyRecord {
  /** The frozen document's hash and time, once the proposal is final (0059). */
  hash: string;
  frozenAt: string;
  /** Where copies were published, with the store's public URL. */
  copies: { store: DocumentStoreName; locator: string; storedAt: string; url: string }[];
}

/** A final proposal's frozen tally record: its hash and published copies; null before the freeze. */
export function useTallyRecord(proposalId: string | null | undefined): AsyncData<TallyRecord | null> {
  return useAsyncData(proposalId, async () => {
    const db = browserClient();
    const frozen = await db.from("proposal_tally_documents")
      .select("hash, frozen_at, community_id").eq("proposal_id", proposalId).maybeSingle();
    if (frozen.error) throw new Error(frozen.error.message);
    if (!frozen.data) return null;
    const record = frozen.data as { hash: string; frozen_at: string; community_id: string };
    const [copies, gateway, settings] = await Promise.all([
      db.from("proposal_document_copies").select(PROPOSAL_DOCUMENT_COPY_COLUMNS).eq("proposal_id", proposalId).order("stored_at"),
      apiFetch<IpfsGatewayResponse>("/api/ipfs/gateway"),
      db.from("governance_community_settings").select(GOVERNANCE_COMMUNITY_SETTINGS_COLUMNS)
        .eq("community_id", record.community_id).maybeSingle(),
    ]);
    if (settings.error) throw new Error(settings.error.message);
    const row = settings.data as GovernanceCommunitySettingsRow | null;
    const githubFullNameByRepoId: Record<string, string> = {};
    if (row?.document_archive_repo_id != null && row.document_archive_full_name) {
      githubFullNameByRepoId[String(row.document_archive_repo_id)] = row.document_archive_full_name;
    }
    const copyRows = unwrap<ProposalDocumentCopyRow[]>(copies);
    // Current settings cover today's archive; older github copies still link if
    // the locator's repo id matches (same community often keeps one archive).
    for (const c of copyRows) {
      if (c.store !== "github") continue;
      const parsed = parseGithubLocator(c.locator);
      if (parsed && !githubFullNameByRepoId[String(parsed.repoId)] && row?.document_archive_full_name
        && Number(row.document_archive_repo_id) === parsed.repoId) {
        githubFullNameByRepoId[String(parsed.repoId)] = row.document_archive_full_name;
      }
    }
    return {
      hash: record.hash,
      frozenAt: record.frozen_at,
      copies: copyRows.map((c) => ({
        store: c.store, locator: c.locator, storedAt: c.stored_at,
        url: copyUrl(c.store, c.locator, { ipfsGateway: gateway.gateway, githubFullNameByRepoId }),
      })),
    };
  });
}

/** The latest settings changes, newest first. */
export function useGovernanceChanges(communityId: string | null | undefined): AsyncData<GovernanceSettingChangeRow[]> {
  return useAsyncData(communityId, async () => unwrap<GovernanceSettingChangeRow[]>(
    await browserClient().from("governance_setting_changes").select(GOVERNANCE_SETTING_CHANGE_COLUMNS)
      .eq("community_id", communityId).order("changed_at", { ascending: false }).limit(20),
  ));
}

/** The open budget proposal of each budget owner (workgroup or treasury id), which locks its budgets. */
export function useOpenBudgetProposals(
  communityId: string | null | undefined,
): AsyncData<Map<string, { id: string; number: number }>> {
  return useAsyncData(communityId, async () => {
    const rows = unwrap<(Pick<ProposalBudgetOwnerRow, "workgroup_id" | "treasury_id"> & {
      proposals: { id: string; number: number } | { id: string; number: number }[];
    })[]>(
      await browserClient().from("proposal_budget_owners")
        .select("workgroup_id, treasury_id, proposals!inner(id, number, community_id)")
        .eq("active", true).eq("proposals.community_id", communityId),
    );
    return new Map(rows.map((row) => {
      const proposal = Array.isArray(row.proposals) ? row.proposals[0]! : row.proposals;
      return [(row.workgroup_id ?? row.treasury_id)!, { id: proposal.id, number: proposal.number }];
    }));
  });
}
