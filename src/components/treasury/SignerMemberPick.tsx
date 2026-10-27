"use client";

import type { MemberWithContributor } from "@/lib/db/types";
import {
  signerMemberGroups,
  signerMemberOptions,
  type SignerMemberOption,
} from "@/lib/treasury/signerMemberOptions";
import type { SignerDraft } from "@/components/treasury/TemplateFields";
import { Select } from "@/components/ui";

/** Fill a signer row from a community member pick. */
export function SignerMemberPick({
  members,
  leadWallets,
  exclude,
  disabled,
  ariaLabel,
  onPick,
}: {
  members: readonly MemberWithContributor[];
  leadWallets: ReadonlySet<string>;
  exclude: ReadonlySet<string>;
  disabled?: boolean;
  ariaLabel: string;
  onPick: (draft: SignerDraft) => void;
}) {
  const options = signerMemberOptions(members, leadWallets, exclude);
  const groups = signerMemberGroups(options);
  if (groups.length === 0) return null;

  function choose(wallet: string) {
    const picked: SignerMemberOption | undefined = options.find((o) => o.wallet === wallet);
    if (!picked) return;
    onPick({ address: picked.wallet, name: picked.name });
  }

  return (
    <Select
      aria-label={ariaLabel}
      className="w-full sm:max-w-xs"
      value=""
      disabled={disabled}
      onChange={(e) => {
        const wallet = e.target.value;
        if (wallet) choose(wallet);
        e.target.value = "";
      }}
    >
      <option value="">Choose a member…</option>
      {groups.map((g) => (
        <optgroup key={g.group} label={g.label}>
          {g.options.map((o) => (
            <option key={o.wallet} value={o.wallet}>{o.label}</option>
          ))}
        </optgroup>
      ))}
    </Select>
  );
}
