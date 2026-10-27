// Pure option list for picking a community member as a treasury signer.
import { isAdminRole } from "@/lib/roles";
import { shortAddress } from "@/lib/format";
import type { MemberWithContributor } from "@/lib/db/types";

export type SignerMemberGroup = "admins" | "leads" | "members";

export interface SignerMemberOption {
  wallet: string;
  label: string;
  /** Suggested display name for the signer row. */
  name: string;
  group: SignerMemberGroup;
}

const GROUP_ORDER: SignerMemberGroup[] = ["admins", "leads", "members"];

export const SIGNER_MEMBER_GROUP_LABELS: Record<SignerMemberGroup, string> = {
  admins: "Admins",
  leads: "Workgroup leads",
  members: "Members",
};

function memberName(m: MemberWithContributor): string {
  return m.contributors?.handle?.trim()
    || m.contributors?.github_username?.trim()
    || "";
}

function memberLabel(m: MemberWithContributor): string {
  const name = memberName(m);
  const short = shortAddress(m.wallet_address);
  return name ? `${name} (${short})` : short;
}

/**
 * Community members as signer picks, admins then leads then members.
 * Wallets in `exclude` (already used on the form) are omitted.
 */
export function signerMemberOptions(
  members: readonly MemberWithContributor[],
  leadWallets: ReadonlySet<string>,
  exclude: ReadonlySet<string> = new Set(),
): SignerMemberOption[] {
  const options: SignerMemberOption[] = [];
  for (const m of members) {
    if (exclude.has(m.wallet_address)) continue;
    const group: SignerMemberGroup = isAdminRole(m.role)
      ? "admins"
      : leadWallets.has(m.wallet_address)
        ? "leads"
        : "members";
    options.push({
      wallet: m.wallet_address,
      label: memberLabel(m),
      name: memberName(m),
      group,
    });
  }
  return options.sort((a, b) => {
    const g = GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group);
    if (g !== 0) return g;
    return a.label.localeCompare(b.label);
  });
}

/** Options already grouped for `<optgroup>` rendering. */
export function signerMemberGroups(
  options: readonly SignerMemberOption[],
): { group: SignerMemberGroup; label: string; options: SignerMemberOption[] }[] {
  return GROUP_ORDER
    .map((group) => ({
      group,
      label: SIGNER_MEMBER_GROUP_LABELS[group],
      options: options.filter((o) => o.group === group),
    }))
    .filter((g) => g.options.length > 0);
}
