"use client";

import { use, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import { Role, Visibility } from "@/lib/constants";
import { DiscordRateSetting } from "@/components/community/DiscordRateSetting";
import { SpendingTokenSetting } from "@/components/community/SpendingTokenSetting";
import { shortAddress } from "@/lib/format";
import { isAdminRole } from "@/lib/roles";
import { browserClient } from "@/lib/supabase/browser";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useAsyncData } from "@/hooks/useAsyncData";
import { useCommunityGate } from "@/hooks/useCommunityGate";
import { useCommunityMembers } from "@/hooks/useCommunityMembers";
import { useWorkgroups } from "@/hooks/useWorkgroups";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorText,
  Input,
  PageTitle,
  Select,
} from "@/components/ui";

/** Lead assignments and signer wallets across the whole community. */
function useCommunityRoles(communityId: string | undefined) {
  return useAsyncData(communityId, async () => {
    const db = browserClient();
    const [{ data: leadRows }, { data: signerRows }] = await Promise.all([
      db
        .from("workgroup_leads")
        .select("workgroup_id, wallet_address, workgroups!inner(community_id)")
        .eq("workgroups.community_id", communityId),
      db
        .from("treasury_signers")
        .select("wallet_address, signer_group, treasuries!inner(community_id)")
        .eq("treasuries.community_id", communityId),
    ]);
    const leads = new Map<string, Set<string>>();
    for (const l of leadRows ?? []) {
      const set = leads.get(l.wallet_address) ?? new Set<string>();
      set.add(l.workgroup_id);
      leads.set(l.wallet_address, set);
    }
    return {
      leads,
      signerGroups: (signerRows ?? []).reduce((map, s) => {
        const set = map.get(s.wallet_address as string) ?? new Set<string>();
        set.add(s.signer_group as string);
        return map.set(s.wallet_address as string, set);
      }, new Map<string, Set<string>>()),
    };
  });
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
  const roles = useCommunityRoles(community?.id);
  const action = useAsyncAction();
  const [newMemberWallet, setNewMemberWallet] = useState("");
  const [visibility, setVisibility] = useState<string | null>(null);

  if (blocked) return blocked;

  function reloadAll() {
    members.reload();
    roles.reload();
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
  const workgroupList = workgroups.data ?? [];
  const memberList = members.data ?? [];

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
            member. Private communities are invite-only: link a GitHub account
            with tasks assigned on this community&apos;s boards, or be added
            below.
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

      <div className="space-y-3">
        {memberList.map((m) => {
          const groups = signerGroups.get(m.wallet_address) ?? new Set<string>();
          const isSigner = groups.has("base");
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
                      disabled={busy || isSigner}
                      title={
                        isSigner
                          ? "Treasury signers must remain admins"
                          : undefined
                      }
                      onClick={() => void setRole(m.wallet_address, Role.Member)}
                    >
                      Demote
                    </Button>
                  )}
                </div>
              </div>
              {workgroupList.length > 0 &&
                (isAdmin || memberLeads.size > 0) &&
                !isAdminRole(m.role) && (
                  <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-zinc-800 pt-3">
                    <span className="text-xs text-zinc-500">Lead of</span>
                    {workgroupList.map((wg) =>
                      isAdmin ? (
                        <label
                          key={wg.id}
                          className="flex cursor-pointer items-center gap-1.5 text-sm"
                        >
                          <input
                            type="checkbox"
                            disabled={busy}
                            checked={memberLeads.has(wg.id)}
                            onChange={(e) =>
                              void toggleLead(m.wallet_address, wg.id, e.target.checked)
                            }
                          />
                          {wg.name}
                        </label>
                      ) : (
                        memberLeads.has(wg.id) && (
                          <Badge key={wg.id}>{wg.name}</Badge>
                        )
                      ),
                    )}
                  </div>
                )}
            </Card>
          );
        })}
        {!members.loading && memberList.length === 0 && (
          <EmptyState>No members yet.</EmptyState>
        )}
      </div>

      <ErrorText error={action.error} className="mt-4" />
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
