"use client";

// Shared bounty picker for GitHub issue editors: add an existing project
// NUMBER field, or create one from ADA / a wallet token (with confirm).

import { useMemo, useState } from "react";
import { Button, ErrorText, Field, Input, Select } from "@/components/ui";
import { apiFetch } from "@/lib/api/client";
import type { GithubProjectFieldResponse } from "@/lib/api/types";
import type { TreasuryWalletToken } from "@/hooks/useTreasuryTokenTickers";
import { useAsyncAction } from "@/hooks/useAsyncAction";

const CREATE = "__create__";
const ADA = "ada";

export type GithubBountyFieldTarget =
  | { taskId: string }
  | { workgroupId: string; itemNodeId: string };

function tokenKey(t: TreasuryWalletToken): string {
  return `${t.treasuryId}:${t.unit}`;
}

function tokenLabel(t: TreasuryWalletToken): string {
  return t.ticker ?? `TOKEN-${t.unit.slice(-6).toUpperCase()}`;
}

export function GithubBountyFieldPicker({
  target,
  numberFieldNames,
  usedFieldNames,
  walletTokens,
  loading = false,
  disabled = false,
  onAddField,
}: {
  target: GithubBountyFieldTarget;
  numberFieldNames: readonly string[];
  /** Field names already on the issue (case-insensitive). */
  usedFieldNames: ReadonlySet<string>;
  walletTokens: readonly TreasuryWalletToken[];
  loading?: boolean;
  disabled?: boolean;
  onAddField: (fieldName: string) => void;
}) {
  const [extraNames, setExtraNames] = useState<string[]>([]);
  const [addValue, setAddValue] = useState("");
  const [creating, setCreating] = useState(false);
  const [tokenChoice, setTokenChoice] = useState(ADA);
  const [fieldName, setFieldName] = useState("ADA");
  const createAction = useAsyncAction("Could not create bounty field");

  const allNames = useMemo(() => {
    const seen = new Set(numberFieldNames.map((n) => n.toLowerCase()));
    const out = [...numberFieldNames];
    for (const name of extraNames) {
      if (seen.has(name.toLowerCase())) continue;
      out.push(name);
      seen.add(name.toLowerCase());
    }
    return out;
  }, [numberFieldNames, extraNames]);

  const available = allNames.filter((name) => !usedFieldNames.has(name.toLowerCase()));

  function pickExisting(name: string) {
    if (!name || name === CREATE) return;
    onAddField(name);
    setAddValue("");
  }

  function selectToken(value: string) {
    setTokenChoice(value);
    if (value === ADA) {
      setFieldName("ADA");
      return;
    }
    const token = walletTokens.find((t) => tokenKey(t) === value);
    setFieldName(token?.ticker ?? "");
  }

  async function confirmCreate() {
    const trimmed = fieldName.trim();
    if (!trimmed) {
      createAction.setError("Enter a field name");
      return;
    }
    const body =
      tokenChoice === ADA
        ? { ...target, kind: "ada" as const, fieldName: trimmed }
        : (() => {
            const token = walletTokens.find((t) => tokenKey(t) === tokenChoice);
            if (!token) return null;
            return {
              ...target,
              kind: "token" as const,
              fieldName: trimmed,
              unit: token.unit,
              treasuryId: token.treasuryId,
            };
          })();
    if (!body) {
      createAction.setError("Pick a wallet token");
      return;
    }
    const result = await createAction.run(() =>
      apiFetch<GithubProjectFieldResponse>("/api/github/project-field", { body }),
    );
    if (!result) return;
    setExtraNames((names) =>
      names.some((n) => n.toLowerCase() === result.fieldName.toLowerCase())
        ? names
        : [...names, result.fieldName],
    );
    onAddField(result.fieldName);
    setCreating(false);
    setAddValue("");
    setTokenChoice(ADA);
    setFieldName("ADA");
  }

  if (creating) {
    return (
      <div className="mt-2 space-y-2 rounded border border-zinc-700 bg-zinc-900/40 p-3">
        <p className="text-xs text-zinc-400">
          This adds a Number field to the linked GitHub project (every issue on
          the board gets it), unless a field with that name already exists.
        </p>
        <Field label="Token">
          <Select
            aria-label="Wallet token for bounty field"
            value={tokenChoice}
            onChange={(e) => selectToken(e.target.value)}
            disabled={createAction.busy}
          >
            <option value={ADA}>ADA</option>
            {walletTokens.map((t) => (
              <option key={tokenKey(t)} value={tokenKey(t)}>
                {tokenLabel(t)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Field name on GitHub">
          <Input
            aria-label="Bounty field name"
            value={fieldName}
            onChange={(e) => setFieldName(e.target.value)}
            disabled={createAction.busy || tokenChoice === ADA}
            maxLength={32}
            placeholder={tokenChoice === ADA ? "ADA" : "Ticker"}
          />
        </Field>
        <ErrorText error={createAction.error} />
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="secondary"
            disabled={createAction.busy}
            onClick={() => {
              setCreating(false);
              setAddValue("");
              createAction.setError(null);
            }}
          >
            Cancel
          </Button>
          <Button loading={createAction.busy} onClick={() => void confirmCreate()}>
            Create field
          </Button>
        </div>
      </div>
    );
  }

  return (
    <Select
      className="mt-2"
      aria-label="Add bounty field"
      value={addValue}
      disabled={disabled || loading}
      onChange={(e) => {
        const value = e.target.value;
        setAddValue(value);
        if (value === CREATE) {
          setCreating(true);
          setTokenChoice(ADA);
          setFieldName("ADA");
          createAction.setError(null);
          return;
        }
        pickExisting(value);
      }}
    >
      <option value="">
        {loading ? "Loading project fields…" : "+ Add bounty field…"}
      </option>
      {available.map((name) => (
        <option key={name} value={name}>{name}</option>
      ))}
      <option value={CREATE}>Create from wallet token…</option>
    </Select>
  );
}
