"use client";

// The token a community mainly budgets and spends: the Dashboard charts it
// first and lists it first in its tables. ADA, any token the community has
// paid out (registry), or one a treasury wallet currently holds. Admin-only
// row inside the Community card on the Members page.
import { useMemo, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import { budgetAssetOptions } from "@/lib/budgets";
import { shortUnit } from "@/lib/format";
import { useAssetRegistry } from "@/hooks/useAssetRegistry";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useTreasuries } from "@/hooks/useTreasuries";
import { useWalletAssetsMany } from "@/hooks/useWalletAssets";
import { Button, ErrorText, NoticeText, Select } from "@/components/ui";

export function SpendingTokenSetting({
  communityId,
  unit,
  onSaved,
}: {
  communityId: string;
  /** The saved main spending token ("lovelace" or a native asset unit). */
  unit: string;
  onSaved: () => void;
}) {
  const registry = useAssetRegistry(communityId);
  const treasuries = useTreasuries(communityId);
  const addresses = useMemo(() => (treasuries.data ?? []).map((treasury) => treasury.address), [treasuries.data]);
  const balances = useWalletAssetsMany(addresses);
  const [choice, setChoice] = useState(unit);
  const [notice, setNotice] = useState<string | null>(null);
  const action = useAsyncAction();

  const options = useMemo(() => {
    const tokens = Object.values(balances.data ?? {}).flatMap((wallet) => wallet.tokens);
    const known = budgetAssetOptions(registry.data ?? [], tokens);
    // The saved token always renders, even when no treasury holds it any more.
    return known.some((asset) => asset.unit === unit)
      ? known
      : [{ fieldName: shortUnit(unit), unit, decimals: 0 }, ...known];
  }, [balances.data, registry.data, unit]);

  const dirty = choice !== unit;
  const valid = options.some((asset) => asset.unit === choice);

  async function save() {
    setNotice(null);
    const ok = await action.run(() =>
      apiFetch("/api/community", {
        method: "PATCH",
        body: { communityId, spendingUnit: choice },
      }),
    );
    if (!ok) return;
    setNotice("Saved. The Dashboard charts this token first.");
    onSaved();
  }

  return (
    <div className="mt-4 border-t border-zinc-800 pt-4">
      <div className="flex flex-col items-start gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
        <label className="text-sm text-zinc-400">Main spending token</label>
        <Select
          aria-label="Main spending token"
          value={choice}
          disabled={action.busy || balances.loading}
          onChange={(e) => setChoice(e.target.value)}
        >
          {options.map((asset) => (
            <option key={asset.unit} value={asset.unit}>{asset.fieldName}</option>
          ))}
        </Select>
        <Button onClick={() => void save()} loading={action.busy} disabled={!valid || !dirty}>
          {action.busy ? "Saving…" : "Save"}
        </Button>
      </div>
      <p className="mt-2 text-xs text-zinc-500">
        Charted first on the Dashboard and listed first in its tables. Choose ADA or any token the
        community has paid out or a treasury wallet holds.
      </p>
      <ErrorText error={action.error ?? balances.error ?? registry.error ?? treasuries.error} className="mt-2" />
      <NoticeText className="mt-2">{notice}</NoticeText>
    </div>
  );
}
