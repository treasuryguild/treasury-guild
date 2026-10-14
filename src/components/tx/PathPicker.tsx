"use client";

// Which branch of the treasury script a build takes, when the treasury
// offers a choice right now: recovery on a clawback treasury from its lock
// date (payments only), bypass on a co-signer treasury. A treasury with one
// path shows nothing; a locked treasury shows why nothing can be built.
import { pathLabel, pathOffered, pathsOfTemplate, type PathTreasury } from "@/lib/cardano/spendingPaths";
import { SpendingPath, type TxKind } from "@/lib/constants";
import { Field, Select, WarningText } from "@/components/ui";

/** The paths a build of this kind may take now, and the reason none can when so. */
export function offeredPaths(treasury: PathTreasury, kind: TxKind, nowMs: number): { paths: SpendingPath[]; blocked: string | null } {
  const paths: SpendingPath[] = [];
  let blocked: string | null = null;
  for (const path of pathsOfTemplate(treasury.template)) {
    const offered = pathOffered(treasury, path, kind, nowMs);
    if (offered.ok) paths.push(path);
    else if (path === SpendingPath.Base) blocked = offered.reason;
  }
  return { paths, blocked: paths.length === 0 ? blocked : null };
}

export function PathPicker({
  treasury,
  kind,
  value,
  onChange,
  disabled,
  nowMs,
}: {
  treasury: PathTreasury | null;
  kind: TxKind;
  value: SpendingPath | "";
  onChange: (path: SpendingPath) => void;
  disabled?: boolean;
  /** The page's clock, fixed at mount (a render must not read Date.now()). */
  nowMs: number;
}) {
  if (!treasury) return null;
  const { paths, blocked } = offeredPaths(treasury, kind, nowMs);
  if (blocked) return <WarningText className="mb-4">{blocked}</WarningText>;
  if (paths.length < 2) return null;
  return (
    <Field label="Spending path" hint={value === SpendingPath.Bypass
      ? "Every base signer signs; the co-signer is not asked."
      : value === SpendingPath.Recovery
        ? "The recovery signers sign; the base signers are not asked."
        : undefined}>
      <Select aria-label="Spending path" value={value || paths[0]} disabled={disabled}
        onChange={(e) => onChange(e.target.value as SpendingPath)}>
        {paths.map((p) => <option key={p} value={p}>{pathLabel(p)}</option>)}
      </Select>
    </Field>
  );
}
