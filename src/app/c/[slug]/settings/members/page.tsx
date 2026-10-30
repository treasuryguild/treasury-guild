"use client";

import Link from "next/link";
import { use, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import { Role, Visibility } from "@/lib/constants";
import { ChangeLeadsDialog } from "@/components/governance/ChangeLeadsDialog";
import { DiscordRateSetting } from "@/components/community/DiscordRateSetting";
import { InviteLinks } from "@/components/community/InviteLinks";
import { SpendingTokenSetting } from "@/components/community/SpendingTokenSetting";
import { formatDate, shortAddress } from "@/lib/format";
import { isLeadPayload } from "@/lib/governance/payload";
import { isAdminRole } from "@/lib/roles";
import { routes } from "@/lib/routes";
import { browserClient } from "@/lib/supabase/browser";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useAsyncData } from "@/hooks/useAsyncData";
import { useCommunityGate } from "@/hooks/useCommunityGate";
import { useCommunityMembers } from "@/hooks/useCommunityMembers";
import { useMyTreasuryRoles } from "@/hooks/useMyTreasuryRoles";
import { useGovernanceSettings, useOpenLeadChanges } from "@/hooks/useProposals";
import { useWorkgroups } from "@/hooks/useWorkgroups";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorText,
  Field,
  Input,
  Modal,
  PageTitle,
  Select,
  Textarea,
} from "@/components/ui";

/** Lead assignments and signer wallets across the whole community. */
function useCommunityRoles(communityId: string | undefined, primaryTreasuryId: string | null | undefined) {
  return useAsyncData(
    communityId ? `${communityId}:${primaryTreasuryId ?? ""}` : null,
    async () => {
      const db = browserClient();
      const [{ data: leadRows }, { data: signerRows }] = await Promise.all([
        db
          .from("workgroup_leads")
          .select("workgroup_id, wallet_address, workgroups!inner(community_id)")
          .eq("workgroups.community_id", communityId),
        db
          .from("treasury_signers")
          .select("wallet_address, signer_group, treasury_id, treasuries!inner(community_id)")
          .eq("treasuries.community_id", communityId),
      ]);
      const leads = new Map<string, Set<string>>();
      for (const l of leadRows ?? []) {
        const set = leads.get(l.wallet_address) ?? new Set<string>();
        set.add(l.workgroup_id);
        leads.set(l.wallet_address, set);
      }
      const primaryBaseSigners = new Set<string>();
      const signerGroups = new Map<string, Set<string>>();
      for (const s of signerRows ?? []) {
        const wallet = s.wallet_address as string;
        const set = signerGroups.get(wallet) ?? new Set<string>();
        set.add(s.signer_group as string);
        signerGroups.set(wallet, set);
        if (
          primaryTreasuryId &&
          s.treasury_id === primaryTreasuryId &&
          s.signer_group === "base"
        ) {
          primaryBaseSigners.add(wallet);
        }
      }
      return { leads, signerGroups, primaryBaseSigners };
    },
  );
}

export default function MembersSettings({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  const { community, isAdmin, sessionWallet, blocked, reload: reloadCommunity } = useCommunityGate(slug);
  const members = useCommunityMembers(community?.id);
  const workgroups = useWorkgroups(community?.id);
  const roles = useCommunityRoles(community?.id, community?.primary_treasury_id);
  const settings = useGovernanceSettings(community?.id);
  const mine = useMyTreasuryRoles(community?.id);
  const openLeads = useOpenLeadChanges(community?.id);
  const overrides = useAsyncData(community?.id ? `lead-overrides:${community.id}` : null, async () => {
    const { data, error } = await browserClient()
      .from("workgroup_lead_overrides")
      .select("id, wallet_address, workgroup_id, reason, created_at")
      .eq("community_id", community!.id)
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) throw new Error(error.message);
    return data ?? [];
  });
  const action = useAsyncAction();
  const [newMemberWallet, setNewMemberWallet] = useState("");
  const [visibility, setVisibility] = useState<string | null>(null);
  const [changing, setChanging] = useState<{ id: string; name: string } | null>(null);
  const [removing, setRemoving] = useState<{ wallet: string; workgroupId: string; name: string } | null>(null);
  const [removeReason, setRemoveReason] = useState("");

  if (blocked) return blocked;

  function reloadAll() {
    members.reload();
    roles.reload();
    overrides.reload();
    openLeads.reload();
  }

  async function removeLeadNow() {
    if (!removing || !removeReason.trim()) return;
    const ok = await action.run(() =>
      apiFetch("/api/workgroup-leads", {
        method: "DELETE",
        body: { workgroupId: removing.workgroupId, wallet: removing.wallet, reason: removeReason.trim() },
      }),
    );
    if (ok) {
      setRemoving(null);
      setRemoveReason("");
      reloadAll();
    }
  }

  async function setRole(wallet: string, role: string) {
    const ok = await action.run(() =>
      apiFetch("/api/members", {
        method: "PATCH",
        body: { communityId: community!.id, wallet, role },
      }),
    );
    if (ok) reloadAll();
  }

  async function toggleLead(wallet: string, workgroupId: string, on: boolean) {
    const ok = await action.run(() =>
      apiFetch("/api/workgroup-leads", {
        method: on ? "POST" : "DELETE",
        body: { workgroupId, wallet },
      }),
    );
    if (ok) reloadAll();
  }

  async function addMember() {
    const wallet = newMemberWallet.trim();
    if (!wallet) return;
    const ok = await action.run(() =>
      apiFetch("/api/members", { body: { communityId: community!.id, wallet } }),
    );
    if (ok) {
      setNewMemberWallet("");
      reloadAll();
    }
  }

  async function setVisibilityChoice(next: string) {
    const prev = visibility ?? community!.visibility;
    setVisibility(next);
    const ok = await action.run(() =>
      apiFetch("/api/community", {
        method: "PATCH",
        body: { communityId: community!.id, visibility: next },
      }),
    );
    if (!ok) setVisibility(prev);
  }

  const currentVisibility = visibility ?? community!.visibility;
  const busy = action.busy;
  const leads = roles.data?.leads ?? new Map<string, Set<string>>();
  const signerGroups = roles.data?.signerGroups ?? new Map<string, Set<string>>();
  const primaryBaseSigners = roles.data?.primaryBaseSigners ?? new Set<string>();
  const workgroupList = workgroups.data ?? [];
  const memberList = members.data ?? [];
  const leadVotesOn = settings.data?.workgroup.enabled === true;
  const directLeads = !!settings.data && !leadVotesOn;
  const canChangeLeads = leadVotesOn && (isAdmin || mine.ledWorkgroupIds.size > 0);

  function leadsOf(workgroupId: string): string[] {
    const wallets: string[] = [];
    for (const [wallet, groups] of leads) if (groups.has(workgroupId)) wallets.push(wallet);
    return wallets;
  }

  function openLeadFor(workgroupId: string) {
    return (openLeads.data ?? []).find(
      (proposal) => isLeadPayload(proposal.payload) && proposal.payload.leadChange.workgroupId === workgroupId,
    );
  }

  return (
    <div>
      <PageTitle>Members</PageTitle>

      {isAdmin && (
        <Card className="mb-6">
          <h3 className="font-medium">Community</h3>
          <div className="mt-3 flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-3">
            <label className="text-sm text-zinc-400">Visibility</label>
            <Select
              value={currentVisibility}
              disabled={busy}
              onChange={(e) => void setVisibilityChoice(e.target.value)}
            >
              <option value={Visibility.Private}>Private</option>
              <option value={Visibility.Public}>Public</option>
            </Select>
          </div>
          <p className="mt-2 text-xs text-zinc-500">
            Public communities appear in discovery and anyone can join as a
            member. Private communities stay off Discover: share an invite link
            below, add a wallet, or let people join via GitHub assignments or
            call check-in.
          </p>
          <DiscordRateSetting
            key={`${community!.discord_rate_coin ?? ""}:${community!.discord_rate_currency}`}
            communityId={community!.id}
            coin={community!.discord_rate_coin}
            currency={community!.discord_rate_currency}
            onSaved={reloadCommunity}
          />
          <SpendingTokenSetting
            key={community!.spending_unit}
            communityId={community!.id}
            unit={community!.spending_unit}
            onSaved={reloadCommunity}
          />
          <InviteLinks communityId={community!.id} />
          <div className="mt-4 flex flex-col items-stretch gap-2 border-t border-zinc-800 pt-4 sm:flex-row sm:items-center">
            <Input
              value={newMemberWallet}
              onChange={(e) => setNewMemberWallet(e.target.value)}
              placeholder="addr… wallet to add as member"
              className="max-w-md font-mono text-xs"
              onKeyDown={(e) => e.key === "Enter" && void addMember()}
            />
            <Button
              disabled={busy || !newMemberWallet.trim()}
              onClick={() => void addMember()}
            >
              Add member
            </Button>
          </div>
        </Card>
      )}

      {canChangeLeads && (
        <Card className="mb-6 space-y-3">
          <h3 className="font-medium">Workgroup leads</h3>
          <p className="text-sm text-zinc-400">
            Adding or removing a lead is a proposal. The other leads can object. An admin can still remove someone immediately, with a reason.
          </p>
          {workgroupList.map((wg) => {
            const open = openLeadFor(wg.id);
            const mayChange = isAdmin || mine.ledWorkgroupIds.has(wg.id);
            return (
              <div key={wg.id} className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm">
                  <span>{wg.name}</span>
                  {open && (
                    <Link className="ml-2 underline" href={routes.proposal(slug, open.id)}>Proposal #{open.number} is open</Link>
                  )}
                </div>
                {mayChange && (
                  <Button variant="secondary" onClick={() => setChanging({ id: wg.id, name: wg.name })}>Change leads</Button>
                )}
              </div>
            );
          })}
        </Card>
      )}

      <div className="space-y-3">
        {memberList.map((m) => {
          const groups = signerGroups.get(m.wallet_address) ?? new Set<string>();
          const isSigner = groups.has("base");
          const isPrimarySigner = primaryBaseSigners.has(m.wallet_address);
          const memberLeads = leads.get(m.wallet_address) ?? new Set<string>();
          const isSelf = m.wallet_address === sessionWallet;
          return (
            <Card key={m.wallet_address}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="font-mono text-sm">
                    {shortAddress(m.wallet_address)}
                    {isSelf && (
                      <span className="ml-2 text-xs text-zinc-500">(you)</span>
                    )}
                  </p>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    {m.contributors?.handle ?? "no handle"}
                    {m.contributors?.github_username && (
                      <span className="ml-2 text-zinc-400">
                        🐙 @{m.contributors.github_username}
                      </span>
                    )}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {isSigner && <Badge tone="green">signer</Badge>}
                  {groups.has("recovery") && <Badge tone="blue">recovery signer</Badge>}
                  {groups.has("cosigner") && <Badge tone="blue">co-signer</Badge>}
                  <Badge tone={isAdminRole(m.role) ? "blue" : "default"}>
                    {m.role}
                  </Badge>
                  {isAdmin && !isSelf && m.role === Role.Member && (
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() => void setRole(m.wallet_address, Role.Admin)}
                    >
                      Make admin
                    </Button>
                  )}
                  {isAdmin && !isSelf && m.role === Role.Admin && (
                    <Button
                      variant="secondary"
                      disabled={busy || isPrimarySigner}
                      title={
                        isPrimarySigner
                          ? "Primary treasury signers must remain admins"
                          : undefined
                      }
                      onClick={() => void setRole(m.wallet_address, Role.Member)}
                    >
                      Demote
                    </Button>
                  )}
                </div>
              </div>
              {workgroupList.length > 0 && !isAdminRole(m.role)
                && (memberLeads.size > 0 || (directLeads && isAdmin)) && (
                  <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-zinc-800 pt-3">
                    <span className="text-xs text-zinc-500">Lead of</span>
                    {workgroupList.map((wg) => {
                      const isLead = memberLeads.has(wg.id);
                      if (directLeads && isAdmin) {
                        return (
                          <label key={wg.id} className="flex cursor-pointer items-center gap-1.5 text-sm">
                            <input type="checkbox" disabled={busy} checked={isLead}
                              onChange={(e) => void toggleLead(m.wallet_address, wg.id, e.target.checked)} />
                            {wg.name}
                          </label>
                        );
                      }
                      if (!isLead) return null;
                      return (
                        <span key={wg.id} className="flex items-center gap-1.5">
                          <Badge>{wg.name}</Badge>
                          {leadVotesOn && isAdmin && (
                            <Button variant="secondary" disabled={busy}
                              onClick={() => { setRemoveReason(""); setRemoving({ wallet: m.wallet_address, workgroupId: wg.id, name: wg.name }); }}>
                              Remove
                            </Button>
                          )}
                        </span>
                      );
                    })}
                  </div>
                )}
            </Card>
          );
        })}
        {!members.loading && memberList.length === 0 && (
          <EmptyState>No members yet.</EmptyState>
        )}
      </div>

      {(overrides.data ?? []).length > 0 && (
        <Card className="mt-6 space-y-2">
          <h3 className="font-medium">Recent lead removals</h3>
          {(overrides.data ?? []).map((row) => {
            const who = memberList.find((member) => member.wallet_address === row.wallet_address);
            const workgroup = workgroupList.find((item) => item.id === row.workgroup_id);
            return (
              <p key={row.id} className="text-sm text-zinc-400">
                {who?.contributors?.handle ?? shortAddress(row.wallet_address)} was removed as a lead of {workgroup?.name ?? "a workgroup"} on {formatDate(row.created_at)}: {row.reason}
              </p>
            );
          })}
        </Card>
      )}

      <ErrorText error={action.error} className="mt-4" />
      {changing && community && (
        <ChangeLeadsDialog open onClose={() => setChanging(null)} communityId={community.id} slug={slug}
          workgroup={changing} members={memberList} currentLeads={leadsOf(changing.id)} sessionWallet={sessionWallet}
          onCreated={reloadAll} />
      )}
      <Modal open={!!removing} onClose={() => setRemoving(null)} busy={busy} title={removing ? `Remove a lead of ${removing.name}` : "Remove a lead"}>
        <div className="space-y-4">
          <p className="text-sm text-zinc-400">This takes effect now. Every member sees the reason.</p>
          <Field label="Reason">
            <Textarea aria-label="Reason for removing this lead" rows={3} maxLength={500} value={removeReason}
              onChange={(e) => setRemoveReason(e.target.value)} />
          </Field>
          <ErrorText error={action.error} />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" disabled={busy} onClick={() => setRemoving(null)}>Cancel</Button>
            <Button variant="danger" loading={busy} disabled={!removeReason.trim()} onClick={() => void removeLeadNow()}>
              Remove lead
            </Button>
          </div>
        </div>
      </Modal>
      {isAdmin && (
        <p className="mt-6 text-xs text-zinc-500">
          Treasury signers are admins automatically. Admins have access to
          everything; workgroup leads can manage their boards and prep
          payouts, which signers then review and sign.
        </p>
      )}
    </div>
  );
}
