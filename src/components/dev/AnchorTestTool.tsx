"use client";

// Dev tool: build a metadata-only anchor transaction from a treasury and
// hand over to the normal transaction page to sign and submit it. The
// phase-0 preprod check of docs/onchain-anchoring-estimate.md.
import Link from "next/link";
import { useState } from "react";
import { apiFetch } from "@/lib/api/client";
import type { DevAnchorTestResponse, DevAnchorTreasuriesResponse } from "@/lib/api/types";
import { asNetwork, networkName } from "@/lib/config";
import { routes } from "@/lib/routes";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useAsyncData } from "@/hooks/useAsyncData";
import { Button, ErrorText, Field, JsonDetails, NoticeText, Select } from "@/components/ui";

export function AnchorTestTool() {
  const treasuries = useAsyncData("dev-anchor-treasuries", () =>
    apiFetch<DevAnchorTreasuriesResponse>("/api/dev/anchor-test"),
  );
  const [treasuryId, setTreasuryId] = useState("");
  const [built, setBuilt] = useState<DevAnchorTestResponse | null>(null);
  const action = useAsyncAction();

  const options = treasuries.data?.treasuries ?? [];
  const selected = treasuryId || options[0]?.id || "";

  async function build() {
    setBuilt(null);
    const result = await action.run(() =>
      apiFetch<DevAnchorTestResponse>("/api/dev/anchor-test", { body: { treasuryId: selected } }),
    );
    if (result) setBuilt(result);
  }

  return (
    <div className="space-y-4">
      <Field
        label="Treasury"
        hint="A treasury you sign for or administer. The transaction spends one of its UTxOs and returns the change, minus the fee (about 0.19 ADA)."
      >
        <Select value={selected} onChange={(e) => setTreasuryId(e.target.value)} disabled={options.length === 0}>
          {options.map((t) => (
            <option key={t.id} value={t.id}>
              {t.communityName} · {t.name} ({networkName(asNetwork(t.network))})
            </option>
          ))}
        </Select>
      </Field>
      <ErrorText error={treasuries.error} />
      <Button onClick={() => void build()} loading={action.busy} disabled={!selected}>
        {action.busy ? "Building…" : "Build anchor test transaction"}
      </Button>
      <ErrorText error={action.error} />
      {built && (
        <div className="space-y-2">
          <NoticeText>
            Built. Sign and submit it on{" "}
            <Link href={routes.tx(built.slug, built.txId)} className="underline">
              the transaction page
            </Link>
            , then run the reconcile sweep above until it is confirmed.
          </NoticeText>
          <JsonDetails label="Label-190002 record" value={built.record} open />
        </div>
      )}
    </div>
  );
}
