"use client";

// The previous wallets a community paid from before Treasury Guild: pick the one
// a CSV belongs to, add one, rename it or remove it with its history.
import { useState } from "react";
import { deserializeAddress } from "@meshsdk/core";
import { apiFetch } from "@/lib/api/client";
import type { LegacyWalletCreatedResponse, LegacyWalletSummary, OkResponse } from "@/lib/api/types";
import { plural, shortAddress } from "@/lib/format";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { Button, Card, ErrorText, Field, Input, Modal, Select, Textarea } from "@/components/ui";
import { formatDay } from "@/lib/legacyHistory/display";

function addressIsScript(address: string): boolean {
  try {
    return !!deserializeAddress(address).scriptHash;
  } catch {
    return false;
  }
}

function WalletForm({
  initial,
  busy,
  error,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: { name: string; address: string; scriptCbor: string };
  busy: boolean;
  error: string | null;
  submitLabel: string;
  onSubmit: (value: { name: string; address: string; scriptCbor?: string | null }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [address, setAddress] = useState(initial.address);
  const [scriptCbor, setScriptCbor] = useState(initial.scriptCbor);
  const scriptAddr = address.trim() ? addressIsScript(address.trim()) : false;
  return (
    <div className="space-y-4">
      <Field label="Name">
        <Input aria-label="Previous wallet name" value={name} maxLength={64} disabled={busy}
          placeholder="Old treasury wallet" onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Address" hint="Required. CSV lines are verified against on-chain transactions from this address.">
        <Input aria-label="Previous wallet address" value={address} disabled={busy} className="font-mono text-xs"
          placeholder="addr1… or addr_test1…" spellCheck={false} onChange={(e) => setAddress(e.target.value)} />
      </Field>
      {(scriptAddr || scriptCbor.trim()) && (
        <Field label="Native script CBOR (hex)" hint="Required for script addresses; must match the address.">
          <Textarea aria-label="Script CBOR" value={scriptCbor} disabled={busy} className="font-mono text-xs"
            rows={4} spellCheck={false} onChange={(e) => setScriptCbor(e.target.value)} />
        </Field>
      )}
      <ErrorText error={error} />
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button loading={busy} disabled={!name.trim() || !address.trim()}
          onClick={() => onSubmit({
            name: name.trim(),
            address: address.trim(),
            scriptCbor: scriptCbor.trim() || null,
          })}>
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}

export function LegacyWalletPanel({
  communityId,
  wallets,
  selectedId,
  onSelect,
  onChanged,
}: {
  communityId: string;
  wallets: LegacyWalletSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onChanged: () => void;
}) {
  const action = useAsyncAction();
  const [dialog, setDialog] = useState<"create" | "edit" | "delete" | null>(null);
  const [confirmName, setConfirmName] = useState("");
  const selected = wallets.find((w) => w.id === selectedId) ?? null;

  function close() {
    setDialog(null);
    setConfirmName("");
    action.setError(null);
  }

  async function create(value: { name: string; address: string; scriptCbor?: string | null }) {
    const result = await action.run(() => apiFetch<LegacyWalletCreatedResponse>("/api/legacy-history/wallets", {
      body: {
        communityId,
        name: value.name,
        address: value.address,
        ...(value.scriptCbor ? { scriptCbor: value.scriptCbor } : {}),
      },
    }));
    if (!result) return;
    close();
    onSelect(result.id);
    onChanged();
  }

  async function edit(value: { name: string; address: string; scriptCbor?: string | null }) {
    if (!selected) return;
    const result = await action.run(() => apiFetch<OkResponse>(`/api/legacy-history/wallets/${selected.id}`, {
      method: "PATCH",
      body: {
        name: value.name,
        address: value.address,
        scriptCbor: value.scriptCbor ?? null,
      },
    }));
    if (!result) return;
    close();
    onChanged();
  }

  async function remove() {
    if (!selected) return;
    const result = await action.run(() => apiFetch<OkResponse>(`/api/legacy-history/wallets/${selected.id}`, {
      method: "DELETE",
      body: { confirmName },
    }));
    if (!result) return;
    close();
    onChanged();
  }

  return (
    <Card className="space-y-4">
      <div>
        <h2 className="text-lg font-medium">Previous wallet</h2>
        <p className="mt-1 text-sm text-zinc-400">
          The wallet the history was paid from. Each CSV line names a chain transaction; a base signer of this wallet
          must sign before imports count on the Dashboard.
        </p>
      </div>
      {wallets.length > 0 ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Select aria-label="Previous wallet" value={selectedId ?? ""} className="sm:max-w-sm"
            onChange={(e) => onSelect(e.target.value)}>
            {wallets.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </Select>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" disabled={!selected} onClick={() => setDialog("edit")}>Edit</Button>
            <Button variant="secondary" disabled={!selected} onClick={() => setDialog("delete")}>Delete</Button>
            <Button variant="ghost" onClick={() => setDialog("create")}>Add another</Button>
          </div>
        </div>
      ) : (
        <Button onClick={() => setDialog("create")}>Add the previous wallet</Button>
      )}
      {selected && (
        <p className="text-xs text-zinc-500">
          <span className="font-mono">{shortAddress(selected.address)}</span>
          {selected.scriptHash ? " · script wallet" : ""}
          {" · "}
          {selected.rowCount === 0
            ? "no history yet"
            : `${plural(selected.rowCount, "payment line")}, ${formatDay(selected.firstPaidOn!)} – ${formatDay(selected.lastPaidOn!)}`}
        </p>
      )}

      <Modal open={dialog === "create"} onClose={close} busy={action.busy} title="Add a previous wallet">
        <WalletForm initial={{ name: "", address: "", scriptCbor: "" }} busy={action.busy} error={action.error}
          submitLabel="Add wallet" onSubmit={(v) => void create(v)} onCancel={close} />
      </Modal>
      <Modal open={dialog === "edit" && !!selected} onClose={close} busy={action.busy} title="Edit previous wallet">
        {selected && (
          <WalletForm initial={{ name: selected.name, address: selected.address, scriptCbor: "" }} busy={action.busy}
            error={action.error} submitLabel="Save" onSubmit={(v) => void edit(v)} onCancel={close} />
        )}
      </Modal>
      <Modal open={dialog === "delete" && !!selected} onClose={close} busy={action.busy} title="Delete previous wallet">
        {selected && (
          <div className="space-y-4">
            <p className="text-sm text-zinc-400">
              This removes the wallet and all {plural(selected.rowCount, "imported payment line")} from the Dashboard
              and budgets. The CSV files themselves are not kept, so keep a copy if you may import them again.
            </p>
            <Field label={`Type “${selected.name}” to confirm`}>
              <Input aria-label="Confirm wallet name" value={confirmName} disabled={action.busy}
                onChange={(e) => setConfirmName(e.target.value)} />
            </Field>
            <ErrorText error={action.error} />
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={close} disabled={action.busy}>Cancel</Button>
              <Button variant="danger" loading={action.busy} disabled={confirmName.trim() !== selected.name}
                onClick={() => void remove()}>
                Delete wallet and history
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </Card>
  );
}
