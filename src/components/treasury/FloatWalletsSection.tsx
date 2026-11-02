"use client";

import { useMemo, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import type { FloatWalletCreatedResponse, OkResponse } from "@/lib/api/types";
import { MAX_FLOAT_WALLETS } from "@/lib/constants";
import {
  FLOAT_EXTERNAL_TX_COLUMNS,
  FLOAT_INCOMING_TX_COLUMNS,
  type FloatExternalTxRow,
  type FloatIncomingTxRow,
  type FloatWalletRow,
} from "@/lib/db/types";
import { formatDate, formatLovelace, formatUnits, shortAddress, shortHash, shortUnit } from "@/lib/format";
import { browserClient } from "@/lib/supabase/browser";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useAsyncData } from "@/hooks/useAsyncData";
import { activeFloatWallets, useFloatWallets } from "@/hooks/useFloatWallets";
import { useWalletAssetsMany } from "@/hooks/useWalletAssets";
import {
  Badge,
  Button,
  Card,
  CopyButton,
  EmptyState,
  ErrorText,
  Input,
  SectionTitle,
} from "@/components/ui";

/** Watched float wallets on the Treasury page: balances and admin CRUD. */
export function FloatWalletsSection({
  communityId,
  isAdmin,
}: {
  communityId: string;
  isAdmin: boolean;
}) {
  const floats = useFloatWallets(communityId);
  const [showArchived, setShowArchived] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [note, setNote] = useState("");
  const create = useAsyncAction("Could not add float wallet");
  const lifecycle = useAsyncAction("Could not update float wallet");

  const list = floats.data ?? [];
  const hasArchived = list.some((f) => f.archived_at);
  const visible = showArchived ? list : activeFloatWallets(list);
  const activeCount = activeFloatWallets(list).length;
  const addresses = useMemo(() => visible.map((f) => f.address), [visible]);
  const balances = useWalletAssetsMany(addresses);

  async function submitCreate() {
    await create.run(async () => {
      await apiFetch<FloatWalletCreatedResponse>("/api/float-wallets", {
        method: "POST",
        body: {
          communityId,
          name: name.trim(),
          address: address.trim(),
          note: note.trim() || null,
        },
      });
      setAdding(false);
      setName("");
      setAddress("");
      setNote("");
      floats.reload();
    });
  }

  async function setArchived(wallet: FloatWalletRow, archive: boolean) {
    await lifecycle.run(async () => {
      await apiFetch<OkResponse>(`/api/float-wallets/${wallet.id}`, {
        method: "POST",
        body: { action: archive ? "archive" : "restore" },
      });
      floats.reload();
    });
  }

  return (
    <div className="mb-10">
      <SectionTitle
        action={
          isAdmin && !adding ? (
            <Button
              variant="secondary"
              disabled={activeCount >= MAX_FLOAT_WALLETS || create.busy}
              onClick={() => setAdding(true)}
            >
              Add float wallet
            </Button>
          ) : undefined
        }
      >
        Float wallets
      </SectionTitle>
      <p className="mb-4 max-w-3xl text-sm text-zinc-400">
        Watched payment-key wallets for DEX and dApp floats. Fund them from a treasury
        on Payments, swap outside the app, then send tokens back. The app never signs
        from these addresses.
      </p>
      <ErrorText error={create.error ?? lifecycle.error ?? floats.error} className="mb-3" />
      {hasArchived && (
        <label className="mb-3 flex items-center gap-2 text-sm text-zinc-400">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          Show archived
        </label>
      )}
      {adding && isAdmin && (
        <Card className="mb-4 space-y-3">
          <p className="text-sm font-medium">New float wallet</p>
          <Input
            aria-label="Float wallet name"
            placeholder="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={create.busy}
          />
          <Input
            aria-label="Float wallet address"
            className="font-mono text-xs"
            placeholder="addr…"
            spellCheck={false}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            disabled={create.busy}
          />
          <Input
            aria-label="Float wallet note"
            placeholder="Note (who holds the key) — optional"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={create.busy}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={create.busy || !name.trim() || !address.trim()}
              onClick={() => void submitCreate()}
            >
              Save
            </Button>
            <Button variant="ghost" disabled={create.busy} onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </Card>
      )}
      {visible.length === 0 && !adding ? (
        <EmptyState>
          {isAdmin
            ? "No float wallets yet. Add one to track a DEX float beside your treasuries."
            : "No float wallets yet."}
        </EmptyState>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {visible.map((wallet) => {
            const balance = balances.data?.[wallet.address];
            const archived = !!wallet.archived_at;
            return (
              <Card key={wallet.id}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{wallet.name}</span>
                      {archived && <Badge>Archived</Badge>}
                    </div>
                    <p className="mt-1 flex flex-wrap items-center gap-2 font-mono text-xs text-zinc-500">
                      {shortAddress(wallet.address)}
                      <CopyButton value={wallet.address} />
                    </p>
                    {wallet.note && (
                      <p className="mt-1 text-sm text-zinc-400">{wallet.note}</p>
                    )}
                    <p className="mt-2 text-lg font-semibold tabular-nums">
                      {balance ? formatLovelace(balance.lovelace) : balances.loading ? "…" : "—"}
                    </p>
                    {balance && balance.tokens.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                        {balance.tokens.map((tok) => (
                          <span key={tok.unit} className="text-sm text-zinc-400" title={tok.unit}>
                            {formatUnits(tok.quantity, tok.decimals, tok.ticker || shortUnit(tok.unit))}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  {isAdmin && (
                    <Button
                      variant="ghost"
                      disabled={lifecycle.busy}
                      onClick={() => void setArchived(wallet, !archived)}
                    >
                      {archived ? "Restore" : "Archive"}
                    </Button>
                  )}
                </div>
                <FloatActivity floatWalletId={wallet.id} />
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Recent float inflows and outs (no signing chrome). */
function FloatActivity({ floatWalletId }: { floatWalletId: string }) {
  const [open, setOpen] = useState(false);
  const activity = useAsyncData(open ? floatWalletId : null, async () => {
    const db = browserClient();
    const [incoming, external] = await Promise.all([
      db
        .from("float_incoming_txs")
        .select(FLOAT_INCOMING_TX_COLUMNS)
        .eq("float_wallet_id", floatWalletId)
        .order("block_time", { ascending: false })
        .limit(8),
      db
        .from("float_external_txs")
        .select(FLOAT_EXTERNAL_TX_COLUMNS)
        .eq("float_wallet_id", floatWalletId)
        .order("block_time", { ascending: false })
        .limit(8),
    ]);
    if (incoming.error) throw new Error(incoming.error.message);
    if (external.error) throw new Error(external.error.message);
    const rows: { kind: "in" | "out"; hash: string; time: string | null; lovelace: string; note: string }[] = [
      ...((incoming.data ?? []) as FloatIncomingTxRow[]).map((row) => ({
        kind: "in" as const,
        hash: row.tx_hash,
        time: row.block_time,
        lovelace: row.amount_lovelace,
        note: row.from_treasury_id ? "From treasury" : "In",
      })),
      ...((external.data ?? []) as FloatExternalTxRow[]).map((row) => ({
        kind: "out" as const,
        hash: row.tx_hash,
        time: row.block_time,
        lovelace: row.amount_lovelace,
        note: row.to_treasury_id ? "To treasury" : "Out",
      })),
    ];
    return rows.sort((a, b) => (b.time ?? "").localeCompare(a.time ?? "")).slice(0, 8);
  });

  return (
    <div className="mt-3 border-t border-zinc-800 pt-3">
      <button
        type="button"
        className="text-sm text-zinc-400 hover:text-zinc-200"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "Hide activity" : "Recent activity"}
      </button>
      {open && (
        <div className="mt-2 space-y-1 text-xs text-zinc-500">
          <ErrorText error={activity.error} />
          {activity.loading && <p>Loading…</p>}
          {activity.data && activity.data.length === 0 && <p>No chain activity yet.</p>}
          {activity.data?.map((row) => (
            <div key={`${row.kind}-${row.hash}`} className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono">
              <span>{row.note}</span>
              <span>{formatLovelace(row.lovelace)}</span>
              <span title={row.hash}>{shortHash(row.hash)}</span>
              {row.time && <span>{formatDate(row.time, "datetime")}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
