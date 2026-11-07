"use client";

import { useMemo, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import type { CommunityStakePoolCreatedResponse, OkResponse } from "@/lib/api/types";
import { MAX_COMMUNITY_STAKE_POOLS } from "@/lib/constants";
import type {
  CommunityStakePoolRow,
  FloatWalletRow,
  StakePoolWalletRole,
  StakePoolWalletRow,
} from "@/lib/db/types";
import { formatLovelace, shortAddress } from "@/lib/format";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useFloatWallets, activeFloatWallets } from "@/hooks/useFloatWallets";
import {
  activeCommunityStakePools,
  useCommunityStakePools,
  useStakePoolWallets,
} from "@/hooks/useCommunityStakePools";
import { useTreasuries } from "@/hooks/useTreasuries";
import { StakePoolPicker } from "@/components/treasury/StakePoolPicker";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorText,
  Field,
  Input,
  SectionTitle,
  Select,
} from "@/components/ui";

const ROLE_LABELS: Record<StakePoolWalletRole, string> = {
  reward_account: "Reward account",
  owner: "Owner / pledge",
  operator_payment: "Operator payment",
  rewards_buffer: "Rewards buffer",
  community_treasury: "Community treasury",
};

type DraftWallet = {
  key: string;
  role: StakePoolWalletRole;
  address: string;
  floatWalletId: string;
  treasuryId: string;
};

function formatMargin(margin: number | null): string {
  if (margin == null) return "—";
  return `${(Number(margin) * 100).toFixed(1)}%`;
}

function draftsFromRows(rows: readonly StakePoolWalletRow[]): DraftWallet[] {
  return rows.map((w, i) => ({
    key: w.id || `row-${i}`,
    role: w.role,
    address: w.address ?? "",
    floatWalletId: w.float_wallet_id ?? "",
    treasuryId: w.treasury_id ?? "",
  }));
}

/** Linked community stake pools on the Treasury page. */
export function StakePoolsSection({
  communityId,
  treasuryId,
  isAdmin,
}: {
  communityId: string;
  /** Any community treasury — used for Koios network on the pool picker. */
  treasuryId: string | null;
  isAdmin: boolean;
}) {
  const pools = useCommunityStakePools(communityId);
  const floats = useFloatWallets(communityId);
  const treasuries = useTreasuries(communityId);
  const [showArchived, setShowArchived] = useState(false);
  const [adding, setAdding] = useState(false);
  const [poolId, setPoolId] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const create = useAsyncAction("Could not link stake pool");
  const patch = useAsyncAction("Could not update stake pool");

  const list = pools.data ?? [];
  const hasArchived = list.some((p) => p.archived_at);
  const visible = showArchived ? list : activeCommunityStakePools(list);
  const activeCount = activeCommunityStakePools(list).length;
  const rewardFloats = useMemo(
    () => activeFloatWallets(floats.data).filter((f) => f.purpose === "pool_rewards"),
    [floats.data],
  );
  const activeTreasuries = useMemo(
    () => (treasuries.data ?? []).filter((t) => !t.archived_at),
    [treasuries.data],
  );

  async function submitCreate() {
    if (!poolId.trim()) return;
    await create.run(async () => {
      await apiFetch<CommunityStakePoolCreatedResponse>("/api/stake-pools", {
        method: "POST",
        body: {
          communityId,
          poolId: poolId.trim(),
          ...(treasuryId && { treasuryId }),
        },
      });
      setAdding(false);
      setPoolId("");
      pools.reload();
    });
  }

  async function refresh(pool: CommunityStakePoolRow) {
    await patch.run(async () => {
      await apiFetch<OkResponse>(`/api/stake-pools/${pool.id}`, {
        method: "PATCH",
        body: { refresh: true },
      });
      pools.reload();
    });
  }

  async function archive(pool: CommunityStakePoolRow) {
    await patch.run(async () => {
      await apiFetch<OkResponse>(`/api/stake-pools/${pool.id}`, {
        method: "PATCH",
        body: { archive: true },
      });
      setEditingId(null);
      pools.reload();
    });
  }

  return (
    <div className="mb-10">
      <SectionTitle
        action={
          isAdmin && !adding && treasuryId ? (
            <Button
              variant="secondary"
              disabled={activeCount >= MAX_COMMUNITY_STAKE_POOLS || create.busy}
              onClick={() => setAdding(true)}
            >
              Add stake pool
            </Button>
          ) : undefined
        }
      >
        Stake pools
      </SectionTitle>
      <p className="mb-4 text-sm text-zinc-600">
        Link a Cardano stake pool the community operates. Margin and known addresses come from the
        chain; rewards that reach a community treasury are booked as revenue on{" "}
        <a className="underline" href="/docs/funding">Funding</a>.
      </p>

      {isAdmin && adding && treasuryId && (
        <Card className="mb-4 space-y-3 p-4">
          <Field label="Stake pool">
            <StakePoolPicker treasuryId={treasuryId} value={poolId} onChange={setPoolId} />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button disabled={!poolId.trim() || create.busy} onClick={() => void submitCreate()}>
              Link pool
            </Button>
            <Button variant="ghost" disabled={create.busy} onClick={() => { setAdding(false); setPoolId(""); }}>
              Cancel
            </Button>
          </div>
          <ErrorText error={create.error} />
        </Card>
      )}

      {hasArchived && (
        <label className="mb-3 flex items-center gap-2 text-sm text-zinc-600">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          Show archived
        </label>
      )}

      {pools.loading && <p className="text-sm text-zinc-500">Loading…</p>}
      <ErrorText error={pools.error} />
      {!pools.loading && visible.length === 0 && (
        <EmptyState>
          {list.length > 0
            ? "Archived stake pools are hidden."
            : "No stake pool linked yet. Admins can add one the community operates."}
        </EmptyState>
      )}

      <div className="space-y-4">
        {visible.map((pool) => (
          <PoolCard
            key={pool.id}
            pool={pool}
            isAdmin={isAdmin}
            editing={editingId === pool.id}
            onEdit={() => setEditingId(pool.id)}
            onCancelEdit={() => setEditingId(null)}
            onRefresh={() => void refresh(pool)}
            onArchive={() => void archive(pool)}
            onSaved={() => { setEditingId(null); pools.reload(); }}
            busy={patch.busy}
            error={patch.error}
            rewardFloats={rewardFloats}
            treasuries={activeTreasuries.map((t) => ({ id: t.id, name: t.name }))}
            allFloats={floats.data ?? []}
            onFloatCreated={() => floats.reload()}
            communityId={communityId}
          />
        ))}
      </div>
    </div>
  );
}

function PoolCard({
  pool,
  isAdmin,
  editing,
  onEdit,
  onCancelEdit,
  onRefresh,
  onArchive,
  onSaved,
  busy,
  error,
  rewardFloats,
  treasuries,
  allFloats,
  onFloatCreated,
  communityId,
}: {
  pool: CommunityStakePoolRow;
  isAdmin: boolean;
  editing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onRefresh: () => void;
  onArchive: () => void;
  onSaved: () => void;
  busy: boolean;
  error: string | null;
  rewardFloats: FloatWalletRow[];
  treasuries: { id: string; name: string }[];
  allFloats: FloatWalletRow[];
  onFloatCreated: () => void;
  communityId: string;
}) {
  const wallets = useStakePoolWallets(pool.id);
  const save = useAsyncAction("Could not save wallet roles");
  const [drafts, setDrafts] = useState<DraftWallet[] | null>(null);
  const rows = drafts ?? draftsFromRows(wallets.data ?? []);

  function beginEdit() {
    setDrafts(draftsFromRows(wallets.data ?? []));
    onEdit();
  }

  async function submitWallets() {
    await save.run(async () => {
      const body = {
        wallets: rows.map((r) => {
          if (r.role === "rewards_buffer") return { role: r.role, floatWalletId: r.floatWalletId };
          if (r.role === "community_treasury") return { role: r.role, treasuryId: r.treasuryId };
          return { role: r.role, address: r.address.trim() };
        }),
      };
      await apiFetch<OkResponse>(`/api/stake-pools/${pool.id}`, { method: "PATCH", body });
      setDrafts(null);
      wallets.reload();
      onSaved();
    });
  }

  async function addRewardsBuffer() {
    const address = window.prompt("Shelley address for the rewards buffer float");
    if (!address?.trim()) return;
    const name = window.prompt("Name for this float", `${pool.ticker ?? "Pool"} rewards`) || "Rewards buffer";
    await save.run(async () => {
      await apiFetch("/api/float-wallets", {
        method: "POST",
        body: {
          communityId,
          name: name.trim(),
          address: address.trim(),
          purpose: "pool_rewards",
          note: `Rewards buffer for ${pool.ticker ?? pool.pool_id}`,
        },
      });
      onFloatCreated();
    });
  }

  return (
    <Card className={`p-4 ${pool.archived_at ? "opacity-70" : ""}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold">{pool.ticker ?? "Pool"}</h3>
            {pool.archived_at && <Badge>Archived</Badge>}
            <code className="font-mono text-xs text-zinc-500">{shortAddress(pool.pool_id)}</code>
          </div>
          <p className="mt-1 text-sm text-zinc-600">
            Margin {formatMargin(pool.margin)}
            {pool.fixed_cost ? ` · fixed ${formatLovelace(pool.fixed_cost)}` : ""}
            {pool.pledge ? ` · pledge ${formatLovelace(pool.pledge)}` : ""}
            {" · "}
            {pool.pool_status}
          </p>
          {pool.reward_address && (
            <p className="mt-1 font-mono text-xs text-zinc-500">
              Reward account {shortAddress(pool.reward_address)}
            </p>
          )}
        </div>
        {isAdmin && !pool.archived_at && (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" disabled={busy || save.busy} onClick={onRefresh}>
              Refresh from chain
            </Button>
            {!editing ? (
              <Button variant="secondary" disabled={wallets.loading} onClick={beginEdit}>
                Map wallets
              </Button>
            ) : (
              <Button variant="ghost" onClick={() => { setDrafts(null); onCancelEdit(); }}>
                Cancel
              </Button>
            )}
            <Button variant="danger" disabled={busy} onClick={onArchive}>
              Archive
            </Button>
          </div>
        )}
      </div>

      {editing && (
        <div className="mt-4 space-y-3 border-t border-zinc-200 pt-4">
          <p className="text-sm text-zinc-600">
            Confirm where rewards land. Income is booked when ADA reaches a community treasury
            (directly or via a rewards buffer float).
          </p>
          {rows.map((row, index) => (
            <div key={row.key} className="grid gap-2 sm:grid-cols-[10rem_1fr_auto]">
              <Select
                value={row.role}
                onChange={(e) => {
                  const role = e.target.value as StakePoolWalletRole;
                  setDrafts((prev) => {
                    const next = [...(prev ?? rows)];
                    next[index] = {
                      ...next[index]!,
                      role,
                      address: role === "rewards_buffer" || role === "community_treasury" ? "" : next[index]!.address,
                      floatWalletId: role === "rewards_buffer" ? next[index]!.floatWalletId : "",
                      treasuryId: role === "community_treasury" ? next[index]!.treasuryId : "",
                    };
                    return next;
                  });
                }}
              >
                {(Object.keys(ROLE_LABELS) as StakePoolWalletRole[]).map((role) => (
                  <option key={role} value={role}>{ROLE_LABELS[role]}</option>
                ))}
              </Select>
              {row.role === "rewards_buffer" ? (
                <Select
                  value={row.floatWalletId}
                  onChange={(e) => {
                    const floatWalletId = e.target.value;
                    setDrafts((prev) => {
                      const next = [...(prev ?? rows)];
                      next[index] = { ...next[index]!, floatWalletId };
                      return next;
                    });
                  }}
                >
                  <option value="">Choose rewards buffer…</option>
                  {rewardFloats.map((f) => (
                    <option key={f.id} value={f.id}>{f.name} ({shortAddress(f.address)})</option>
                  ))}
                  {allFloats
                    .filter((f) => f.purpose === "pool_rewards" && f.archived_at)
                    .map((f) => (
                      <option key={f.id} value={f.id} disabled>
                        {f.name} (archived)
                      </option>
                    ))}
                </Select>
              ) : row.role === "community_treasury" ? (
                <Select
                  value={row.treasuryId}
                  onChange={(e) => {
                    const treasuryId = e.target.value;
                    setDrafts((prev) => {
                      const next = [...(prev ?? rows)];
                      next[index] = { ...next[index]!, treasuryId };
                      return next;
                    });
                  }}
                >
                  <option value="">Choose treasury…</option>
                  {treasuries.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </Select>
              ) : (
                <Input
                  value={row.address}
                  onChange={(e) => {
                    const address = e.target.value;
                    setDrafts((prev) => {
                      const next = [...(prev ?? rows)];
                      next[index] = { ...next[index]!, address };
                      return next;
                    });
                  }}
                  placeholder="Address"
                />
              )}
              <Button
                variant="ghost"
                onClick={() => setDrafts((prev) => (prev ?? rows).filter((_, i) => i !== index))}
              >
                Remove
              </Button>
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={() =>
                setDrafts((prev) => [
                  ...(prev ?? rows),
                  {
                    key: `new-${Date.now()}`,
                    role: "operator_payment",
                    address: "",
                    floatWalletId: "",
                    treasuryId: "",
                  },
                ])
              }
            >
              Add wallet
            </Button>
            <Button variant="secondary" disabled={save.busy} onClick={() => void addRewardsBuffer()}>
              Create rewards buffer float
            </Button>
            <Button disabled={save.busy} onClick={() => void submitWallets()}>
              Save mappings
            </Button>
          </div>
          <ErrorText error={save.error || error} />
        </div>
      )}

      {!editing && (wallets.data?.length ?? 0) > 0 && (
        <ul className="mt-3 space-y-1 text-sm text-zinc-600">
          {(wallets.data ?? []).map((w) => (
            <li key={w.id}>
              <span className="font-medium">{ROLE_LABELS[w.role]}</span>
              {": "}
              {w.address
                ? shortAddress(w.address)
                : w.float_wallet_id
                  ? `float ${shortAddress(w.float_wallet_id)}`
                  : w.treasury_id
                    ? `treasury ${shortAddress(w.treasury_id)}`
                    : "—"}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
