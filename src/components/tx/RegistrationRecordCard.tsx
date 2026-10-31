"use client";

// The label-1854 CIP-0146 registration a transaction carries, decoded from
// its CBOR: wallet name, roles, each participant key hash with its display
// name, then the raw record with its legend.
import {
  joinMetadataString,
  parseLabel1854Metadata,
} from "@/lib/cardano/cip146Registration";
import { registrationLegend } from "@/lib/cardano/metadataLegend";
import { shortHash } from "@/lib/format";
import { Card, InsetRow, JsonDetails } from "@/components/ui";

const TYPE_LABELS: Record<number, string> = {
  0: "Payment",
  2: "Stake",
  3: "DRep",
};

function typeLabel(t: number): string {
  return TYPE_LABELS[t] ?? `Type ${t}`;
}

export function RegistrationRecordCard({ registrationMeta }: {
  registrationMeta: unknown;
}) {
  if (registrationMeta === null || registrationMeta === undefined) return null;
  const parsed = parseLabel1854Metadata(registrationMeta);
  const name = parsed ? joinMetadataString(parsed.name) : "";
  const description = parsed ? joinMetadataString(parsed.description) : "";
  const participants = parsed?.participants
    ? Object.entries(parsed.participants).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    : [];

  return (
    <Card className="mb-4">
      <h3 className="mb-3 text-sm font-medium text-zinc-400">Wallet registration</h3>
      {parsed ? (
        <div className="space-y-2">
          {name && (
            <InsetRow>
              <span className="text-sm text-zinc-400">Name</span>
              <span className="text-sm">{name}</span>
            </InsetRow>
          )}
          {description && (
            <InsetRow>
              <span className="text-sm text-zinc-400">Description</span>
              <span className="text-sm">{description}</span>
            </InsetRow>
          )}
          <InsetRow>
            <span className="text-sm text-zinc-400">Types</span>
            <span className="text-sm">
              {parsed.types.map(typeLabel).join(" · ")}
            </span>
          </InsetRow>
          {participants.map(([hash, info]) => (
            <InsetRow key={hash}>
              <span className="font-mono text-xs text-zinc-400">{shortHash(hash, 12)}</span>
              <span className="text-sm">{info.name || "—"}</span>
            </InsetRow>
          ))}
        </div>
      ) : (
        <p className="text-sm text-zinc-500">
          A label-1854 value that is not a CIP-0146 registration record (the raw value is below).
        </p>
      )}
      <JsonDetails
        label="On-chain registration (label 1854)"
        value={registrationMeta}
        legend={registrationLegend(registrationMeta)}
      />
    </Card>
  );
}
