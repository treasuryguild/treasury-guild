"use client";

import { MAX_ASSET_NAME_BYTES, MAX_TICKER_CHARS } from "@/lib/cardano/mintMetadata";
import type { MintFormState } from "@/lib/mint/types";
import { Field, Input, Textarea } from "@/components/ui";
import { ImageUpload } from "./ImageUpload";

const MAX_DECIMALS = 12;

export function FungibleTokenForm({
  form,
  patch,
  communityId,
  gateway,
}: {
  form: MintFormState;
  patch: (next: Partial<MintFormState>) => void;
  communityId: string;
  gateway: string | null;
}) {
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={`Asset name (on-chain, ≤${MAX_ASSET_NAME_BYTES} bytes)`}>
          <Input
            value={form.ftName}
            onChange={(e) => patch({ ftName: e.target.value })}
            placeholder="GuildToken"
            maxLength={MAX_ASSET_NAME_BYTES}
          />
        </Field>
        <Field label="Ticker">
          <Input
            value={form.ticker}
            onChange={(e) => patch({ ticker: e.target.value.toUpperCase() })}
            placeholder="GVT"
            maxLength={MAX_TICKER_CHARS}
          />
        </Field>
        <Field label="Decimals">
          <Input
            type="number"
            min={0}
            max={MAX_DECIMALS}
            value={form.decimals}
            onChange={(e) =>
              patch({
                decimals: Math.max(0, Math.min(MAX_DECIMALS, Number(e.target.value) || 0)),
              })
            }
          />
        </Field>
        <Field label={`Total supply ${form.ticker ? `(${form.ticker})` : ""}`}>
          <Input
            inputMode="decimal"
            value={form.supply}
            onChange={(e) => patch({ supply: e.target.value })}
            placeholder="1000000"
          />
        </Field>
      </div>
      <Field label="Description">
        <Textarea
          rows={2}
          value={form.ftDescription}
          onChange={(e) => patch({ ftDescription: e.target.value })}
          placeholder="What is this token for?"
        />
      </Field>
      <Field label="Website (optional)">
        <Input
          value={form.url}
          onChange={(e) => patch({ url: e.target.value })}
          placeholder="https://"
        />
      </Field>
      <ImageUpload
        communityId={communityId}
        state={form.ftImage}
        gateway={gateway}
        onChange={(ftImage) => patch({ ftImage })}
        label="Logo"
      />
    </>
  );
}
