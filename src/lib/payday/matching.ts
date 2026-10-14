// Client-side view of the token matching the build route will redo: which
// bounty fields resolve to wallet tokens, which need a manual connection.

import type { WalletTokenWire } from "@/lib/api/types";
import { ADA_ASSET, type AssetDef } from "@/lib/assets";
import { matchTokensToFields } from "@/lib/tokenMatch";

export interface PaydayMatching {
  /** Registry + auto matches + manual connections (manual wins). */
  effective: AssetDef[];
  /** Field -> candidate tokens (null = any wallet token). */
  needsPick: Map<string, WalletTokenWire[] | null>;
  /** Fields whose persisted mapping points at a token this wallet lacks. */
  stale: string[];
  /** Fields that still block the build. */
  unresolved: string[];
}

const isAda = (field: string) => field.toLowerCase() === ADA_ASSET.fieldName.toLowerCase();

export function deriveMatching(
  fields: string[],
  registry: AssetDef[],
  tokens: WalletTokenWire[],
  connections: Record<string, string>,
): PaydayMatching {
  const { auto, ambiguous, unmatched } = matchTokensToFields(fields, registry, tokens);

  const effective: AssetDef[] = [...registry, ...auto];
  for (const [field, unit] of Object.entries(connections)) {
    const token = tokens.find((t) => t.unit === unit);
    if (!token) continue;
    const lower = field.toLowerCase();
    const idx = effective.findIndex((a) => a.fieldName.toLowerCase() === lower);
    if (idx >= 0) effective.splice(idx, 1);
    effective.push({ fieldName: field, unit, decimals: token.decimals });
  }

  // Fields needing a manual pick: no match, ambiguous match, or a persisted
  // mapping whose token this wallet doesn't hold.
  const held = new Set(tokens.map((t) => t.unit));
  const stale = fields.filter((f) => {
    if (isAda(f)) return false;
    const def = registry.find((a) => a.fieldName.toLowerCase() === f.toLowerCase());
    return !!def && !held.has(def.unit);
  });
  const needsPick = new Map<string, WalletTokenWire[] | null>();
  for (const f of unmatched) needsPick.set(f, null);
  for (const [f, candidates] of ambiguous) {
    needsPick.set(
      f,
      tokens.filter((t) => candidates.some((c) => c.unit === t.unit)),
    );
  }
  for (const f of stale) if (!needsPick.has(f)) needsPick.set(f, null);

  // Stale mappings only warn (the persisted mapping still resolves); the
  // over-budget check catches a missing balance.
  const unresolved = [...needsPick.keys()].filter(
    (f) => !connections[f] && !stale.includes(f),
  );

  return { effective, needsPick, stale, unresolved };
}
