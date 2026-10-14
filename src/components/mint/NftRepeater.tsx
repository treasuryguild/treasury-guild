"use client";

import { MAX_NFTS_PER_TX } from "@/lib/api/schemas";
import { MAX_ASSET_NAME_BYTES } from "@/lib/cardano/mintMetadata";
import { emptyNft, type NftDraft } from "@/lib/mint/types";
import { Button, Field, Input, Panel, Textarea } from "@/components/ui";
import { ImageUpload } from "./ImageUpload";

function NftDraftCard({
  index,
  nft,
  onChange,
  onRemove,
  communityId,
  gateway,
}: {
  index: number;
  nft: NftDraft;
  onChange: (next: NftDraft) => void;
  onRemove?: () => void;
  communityId: string;
  gateway: string | null;
}) {
  const setAttribute = (k: number, patch: Partial<{ key: string; value: string }>) =>
    onChange({
      ...nft,
      attributes: nft.attributes.map((a, i) => (i === k ? { ...a, ...patch } : a)),
    });

  return (
    <Panel className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">NFT #{index + 1}</p>
        {onRemove && (
          <Button variant="ghost" onClick={onRemove}>
            Remove
          </Button>
        )}
      </div>
      <Field label={`Name (on-chain asset name, ≤${MAX_ASSET_NAME_BYTES} bytes)`}>
        <Input
          value={nft.name}
          maxLength={MAX_ASSET_NAME_BYTES}
          onChange={(e) => onChange({ ...nft, name: e.target.value })}
          placeholder="Guild Badge #1"
        />
      </Field>
      <Field label="Description">
        <Textarea
          rows={2}
          value={nft.description}
          onChange={(e) => onChange({ ...nft, description: e.target.value })}
        />
      </Field>
      <ImageUpload
        communityId={communityId}
        state={nft.image}
        gateway={gateway}
        onChange={(image) => onChange({ ...nft, image })}
        label="Image"
      />
      <Field label="Traits (optional)">
        <div className="space-y-2">
          {nft.attributes.map((a, k) => (
            <div key={k} className="flex flex-col gap-2 sm:flex-row">
              <Input
                className="sm:max-w-48"
                value={a.key}
                placeholder="rarity"
                onChange={(e) => setAttribute(k, { key: e.target.value })}
              />
              <Input
                value={a.value}
                placeholder="legendary"
                onChange={(e) => setAttribute(k, { value: e.target.value })}
              />
            </div>
          ))}
        </div>
        <Button
          variant="ghost"
          className="mt-2"
          onClick={() =>
            onChange({ ...nft, attributes: [...nft.attributes, { key: "", value: "" }] })
          }
        >
          + Add trait
        </Button>
      </Field>
    </Panel>
  );
}

export function NftRepeater({
  nfts,
  onChange,
  communityId,
  gateway,
}: {
  nfts: NftDraft[];
  onChange: (next: NftDraft[]) => void;
  communityId: string;
  gateway: string | null;
}) {
  return (
    <div className="space-y-4">
      {nfts.map((n, i) => (
        <NftDraftCard
          key={i}
          index={i}
          nft={n}
          communityId={communityId}
          gateway={gateway}
          onChange={(next) => onChange(nfts.map((p, j) => (j === i ? next : p)))}
          onRemove={
            nfts.length > 1 ? () => onChange(nfts.filter((_, j) => j !== i)) : undefined
          }
        />
      ))}
      {nfts.length < MAX_NFTS_PER_TX && (
        <Button variant="secondary" onClick={() => onChange([...nfts, emptyNft()])}>
          + Add another NFT (same transaction)
        </Button>
      )}
    </div>
  );
}
