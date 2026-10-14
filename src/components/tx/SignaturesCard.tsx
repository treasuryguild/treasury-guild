import type { SigningRule } from "@/lib/cardano/spendingPaths";
import { describeRule } from "@/lib/cardano/thresholds";
import { shortAddress } from "@/lib/format";
import { Badge, Card } from "@/components/ui";
import type { TxPanelSigner } from "./types";

/**
 * Who has signed or rejected, grouped as the transaction's spending path
 * counts them: the path's group, then the co-signer when one is required.
 * Signers outside the path (the recovery group of a base-path transaction,
 * the base group of a recovery one) are not shown: their signatures would
 * not count.
 */
export function SignaturesCard({
  signers,
  signedAddresses,
  rejectedAddresses,
  rule,
}: {
  signers: TxPanelSigner[];
  signedAddresses: string[];
  rejectedAddresses: string[];
  rule: SigningRule;
}) {
  const byAddress = new Map(signers.map((s) => [s.wallet_address, s]));
  const badge = (address: string) => {
    const s = byAddress.get(address);
    const signed = signedAddresses.includes(address);
    const rejected = rejectedAddresses.includes(address);
    return (
      <Badge key={address} tone={signed ? "green" : rejected ? "red" : "default"}>
        {s?.display_name || shortAddress(address)}
        {signed ? " ✓" : rejected ? " ✗" : ""}
      </Badge>
    );
  };
  const collected = signedAddresses.filter((a) => rule.members.includes(a) || rule.alsoRequired.includes(a)).length;
  return (
    <Card className="mb-4">
      <h3 className="mb-3 text-sm font-medium text-zinc-400">
        Signatures ({collected} collected · {describeRule(rule)} required)
      </h3>
      <div className="flex flex-wrap gap-2">{rule.members.map(badge)}</div>
      {rule.alsoRequired.length > 0 && (
        <div className="mt-3">
          <p className="mb-1 text-xs text-zinc-500">Co-signer (signs only what passes the check)</p>
          <div className="flex flex-wrap gap-2">{rule.alsoRequired.map(badge)}</div>
        </div>
      )}
    </Card>
  );
}
