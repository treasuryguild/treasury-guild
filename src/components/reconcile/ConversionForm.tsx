"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api/client";
import type { ConversionCreatedResponse, OkResponse } from "@/lib/api/types";
import type {
  ConversionChain,
  ConversionFeeKind,
  ConversionKind,
  IncomingConversionFeeRow,
  IncomingConversionProofRow,
  IncomingConversionRow,
} from "@/lib/db/types";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { Badge, Button, ErrorText, Field, Input, Select, Textarea } from "@/components/ui";

export type ConversionView = IncomingConversionRow & {
  fees: IncomingConversionFeeRow[];
  proofs: IncomingConversionProofRow[];
};

type FeeDraft = { kind: ConversionFeeKind; amount: string; assetLabel: string; chain: ConversionChain | "" };
type ProofDraft = { chain: ConversionChain; txHash: string; url: string; label: string };

const CHAINS: { value: ConversionChain; label: string }[] = [
  { value: "ethereum", label: "Ethereum" },
  { value: "cardano", label: "Cardano" },
  { value: "bitcoin", label: "Bitcoin" },
  { value: "other", label: "Other" },
];

const FEE_KINDS: { value: ConversionFeeKind; label: string }[] = [
  { value: "gas", label: "Gas" },
  { value: "bridge", label: "Bridge fee" },
  { value: "spread", label: "Spread" },
  { value: "other", label: "Other" },
];

function emptyFee(): FeeDraft {
  return { kind: "gas", amount: "", assetLabel: "", chain: "ethereum" };
}
function emptyProof(): ProofDraft {
  return { chain: "ethereum", txHash: "", url: "", label: "" };
}

/** Admin create/edit for a bridge or swap episode on one Cardano inflow. */
export function ConversionForm({
  attach,
  existing,
  receivedLabel,
  onSaved,
  onCancel,
}: {
  attach: { incomingTxHash: string } | { floatIncomingTxHash: string };
  existing?: ConversionView | null;
  /** Read-only summary of what arrived on Cardano. */
  receivedLabel: string;
  onSaved: () => void;
  onCancel?: () => void;
}) {
  const [kind, setKind] = useState<ConversionKind>(existing?.kind ?? "bridge");
  const [sentAmount, setSentAmount] = useState(existing?.sent_amount ?? "");
  const [sentAssetLabel, setSentAssetLabel] = useState(existing?.sent_asset_label ?? "");
  const [sentChain, setSentChain] = useState<ConversionChain>(existing?.sent_chain ?? "ethereum");
  const [sentAddress, setSentAddress] = useState(existing?.sent_address ?? "");
  const [note, setNote] = useState(existing?.note ?? "");
  const [fees, setFees] = useState<FeeDraft[]>(
    existing?.fees.length
      ? existing.fees.map((f) => ({
        kind: f.kind, amount: f.amount, assetLabel: f.asset_label, chain: f.chain ?? "",
      }))
      : [],
  );
  const [proofs, setProofs] = useState<ProofDraft[]>(
    existing?.proofs.length
      ? existing.proofs.map((p) => ({
        chain: p.chain, txHash: p.tx_hash, url: p.url ?? "", label: p.label ?? "",
      }))
      : [],
  );
  const save = useAsyncAction("Could not save conversion");
  const remove = useAsyncAction("Could not delete conversion");

  function body() {
    return {
      kind,
      sentAmount: sentAmount.trim(),
      sentAssetLabel: sentAssetLabel.trim(),
      sentChain,
      sentAddress: sentAddress.trim() || null,
      note: note.trim() || null,
      fees: fees
        .filter((f) => f.amount.trim() && f.assetLabel.trim())
        .map((f) => ({
          kind: f.kind,
          amount: f.amount.trim(),
          assetLabel: f.assetLabel.trim(),
          chain: f.chain || null,
        })),
      proofs: proofs
        .filter((p) => p.txHash.trim())
        .map((p) => ({
          chain: p.chain,
          txHash: p.txHash.trim(),
          url: p.url.trim() || null,
          label: p.label.trim() || null,
        })),
    };
  }

  async function submit() {
    const payload = body();
    const result = await save.run(async () => {
      if (existing) {
        await apiFetch<OkResponse>(`/api/conversions/${existing.id}`, { method: "PATCH", body: payload });
      } else {
        await apiFetch<ConversionCreatedResponse>("/api/conversions", {
          method: "POST",
          body: { ...payload, ...attach },
        });
      }
    });
    if (result !== undefined) onSaved();
  }

  async function destroy() {
    if (!existing) return;
    const result = await remove.run(() =>
      apiFetch<OkResponse>(`/api/conversions/${existing.id}`, { method: "DELETE" }),
    );
    if (result !== undefined) onSaved();
  }

  return (
    <div className="mt-3 space-y-3 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium">
          {existing ? "Edit conversion" : "Record conversion"}
        </p>
        <Badge>{kind === "bridge" ? "Bridge" : "Swap"}</Badge>
      </div>
      <p className="text-xs text-zinc-500">Received on Cardano: {receivedLabel}</p>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Kind">
          <Select value={kind} onChange={(e) => setKind(e.target.value as ConversionKind)} aria-label="Conversion kind">
            <option value="bridge">Bridge</option>
            <option value="swap">Swap</option>
          </Select>
        </Field>
        <Field label="Sent chain">
          <Select value={sentChain} onChange={(e) => setSentChain(e.target.value as ConversionChain)} aria-label="Sent chain">
            {CHAINS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </Select>
        </Field>
        <Field label="Sent amount">
          <Input value={sentAmount} onChange={(e) => setSentAmount(e.target.value)} placeholder="100" />
        </Field>
        <Field label="Sent asset">
          <Input value={sentAssetLabel} onChange={(e) => setSentAssetLabel(e.target.value)} placeholder="FET" />
        </Field>
      </div>
      <Field label="Sent address (optional)" hint="Foreign or other-chain address that paid into the bridge or swap.">
        <Input className="font-mono text-xs" value={sentAddress} onChange={(e) => setSentAddress(e.target.value)} spellCheck={false} />
      </Field>

      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="text-sm font-medium">Fees</p>
          <Button type="button" variant="ghost" onClick={() => setFees((list) => [...list, emptyFee()])}>Add fee</Button>
        </div>
        {fees.length === 0 && <p className="text-xs text-zinc-500">No fees recorded.</p>}
        <div className="space-y-2">
          {fees.map((fee, index) => (
            <div key={index} className="grid gap-2 md:grid-cols-4">
              <Select value={fee.kind} onChange={(e) => setFees((list) => list.map((row, i) => i === index ? { ...row, kind: e.target.value as ConversionFeeKind } : row))} aria-label={`Fee ${index + 1} kind`}>
                {FEE_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
              </Select>
              <Input value={fee.amount} onChange={(e) => setFees((list) => list.map((row, i) => i === index ? { ...row, amount: e.target.value } : row))} placeholder="Amount" aria-label={`Fee ${index + 1} amount`} />
              <Input value={fee.assetLabel} onChange={(e) => setFees((list) => list.map((row, i) => i === index ? { ...row, assetLabel: e.target.value } : row))} placeholder="ETH" aria-label={`Fee ${index + 1} asset`} />
              <div className="flex gap-2">
                <Select className="min-w-0 flex-1" value={fee.chain} onChange={(e) => setFees((list) => list.map((row, i) => i === index ? { ...row, chain: e.target.value as ConversionChain | "" } : row))} aria-label={`Fee ${index + 1} chain`}>
                  <option value="">No chain</option>
                  {CHAINS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                </Select>
                <Button type="button" variant="ghost" onClick={() => setFees((list) => list.filter((_, i) => i !== index))}>Remove</Button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="text-sm font-medium">Proofs</p>
          <Button type="button" variant="ghost" onClick={() => setProofs((list) => [...list, emptyProof()])}>Add proof</Button>
        </div>
        {proofs.length === 0 && <p className="text-xs text-zinc-500">No foreign-chain hashes yet.</p>}
        <div className="space-y-2">
          {proofs.map((proof, index) => (
            <div key={index} className="grid gap-2 md:grid-cols-2">
              <Select value={proof.chain} onChange={(e) => setProofs((list) => list.map((row, i) => i === index ? { ...row, chain: e.target.value as ConversionChain } : row))} aria-label={`Proof ${index + 1} chain`}>
                {CHAINS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </Select>
              <Input className="font-mono text-xs" value={proof.txHash} onChange={(e) => setProofs((list) => list.map((row, i) => i === index ? { ...row, txHash: e.target.value } : row))} placeholder="Tx hash" aria-label={`Proof ${index + 1} hash`} spellCheck={false} />
              <Input value={proof.label} onChange={(e) => setProofs((list) => list.map((row, i) => i === index ? { ...row, label: e.target.value } : row))} placeholder="Label (optional)" aria-label={`Proof ${index + 1} label`} />
              <div className="flex gap-2">
                <Input className="min-w-0 flex-1" value={proof.url} onChange={(e) => setProofs((list) => list.map((row, i) => i === index ? { ...row, url: e.target.value } : row))} placeholder="https://… (optional)" aria-label={`Proof ${index + 1} url`} />
                <Button type="button" variant="ghost" onClick={() => setProofs((list) => list.filter((_, i) => i !== index))}>Remove</Button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <Field label="Note (optional)">
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Bridge route, rate context…" />
      </Field>

      <div className="flex flex-wrap gap-2">
        <Button loading={save.busy} disabled={!sentAmount.trim() || !sentAssetLabel.trim()} onClick={() => void submit()}>
          {existing ? "Save conversion" : "Create conversion"}
        </Button>
        {onCancel && <Button variant="ghost" disabled={save.busy || remove.busy} onClick={onCancel}>Cancel</Button>}
        {existing && (
          <Button variant="ghost" disabled={save.busy || remove.busy} loading={remove.busy} onClick={() => void destroy()}>
            Delete
          </Button>
        )}
      </div>
      <ErrorText error={save.error ?? remove.error} />
    </div>
  );
}

/** Compact read-only summary + optional edit affordance. */
export function ConversionSummary({
  conversion,
  isAdmin,
  onEdit,
}: {
  conversion: ConversionView;
  isAdmin: boolean;
  onEdit?: () => void;
}) {
  return (
    <div className="mt-3 rounded-lg border border-zinc-800 px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge>{conversion.kind === "bridge" ? "Bridge" : "Swap"}</Badge>
        <span>
          Sent {conversion.sent_amount} {conversion.sent_asset_label}
          {" "}on {conversion.sent_chain}
        </span>
        {isAdmin && onEdit && (
          <Button variant="ghost" onClick={onEdit}>Edit</Button>
        )}
      </div>
      {conversion.fees.length > 0 && (
        <p className="mt-1 text-xs text-zinc-500">
          Fees: {conversion.fees.map((f) => `${f.amount} ${f.asset_label}`).join(", ")}
        </p>
      )}
      {conversion.proofs.length > 0 && (
        <p className="mt-1 font-mono text-xs text-zinc-500">
          Proofs: {conversion.proofs.map((p) => p.tx_hash).join(", ")}
        </p>
      )}
      {conversion.note && <p className="mt-1 text-xs text-zinc-400">{conversion.note}</p>}
    </div>
  );
}
