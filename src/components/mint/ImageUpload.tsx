"use client";

import { PinataSDK } from "pinata";
import { apiFetch } from "@/lib/api/client";
import type { IpfsSignUploadResponse } from "@/lib/api/types";
import { errorMessage } from "@/lib/errors";
import { ipfsUrl } from "@/lib/ipfs";
import type { ImageState } from "@/lib/mint/types";
import { CopyButton, ErrorText, Field } from "@/components/ui";

export function ImageUpload({
  communityId,
  state,
  gateway,
  onChange,
  label,
}: {
  communityId: string;
  state: ImageState;
  gateway: string | null;
  onChange: (next: ImageState) => void;
  label: string;
}) {
  async function upload(file: File) {
    onChange({ ...state, uploading: true, error: null });
    try {
      const signed = await apiFetch<IpfsSignUploadResponse>("/api/ipfs/sign-upload", {
        body: {
          communityId,
          name: file.name,
          mimeType: file.type,
          size: file.size,
        },
      });
      // Browser -> Pinata directly, authorised only by the short-lived URL.
      const result = await new PinataSDK({}).upload.public.file(file).url(signed.url);
      onChange({
        cid: result.cid,
        mediaType: file.type,
        fileName: file.name,
        uploading: false,
        error: null,
      });
    } catch (err) {
      onChange({
        ...state,
        uploading: false,
        error: errorMessage(err, "Upload failed"),
      });
    }
  }

  const previewUrl = state.cid && gateway ? ipfsUrl(gateway, state.cid) : null;

  return (
    <Field label={label}>
      <div className="flex flex-col items-start gap-4 sm:flex-row">
        {previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={previewUrl}
            alt=""
            className="h-24 w-24 shrink-0 rounded-lg border border-zinc-800 bg-zinc-900 object-cover"
          />
        ) : (
          <div className="flex h-24 w-24 shrink-0 items-center justify-center rounded-lg border border-dashed border-zinc-700 text-2xl text-zinc-600">
            {state.uploading ? "…" : "🖼"}
          </div>
        )}
        <div className="min-w-0 flex-1 space-y-2">
          <input
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            disabled={state.uploading}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
              e.target.value = "";
            }}
            className="block w-full text-sm text-zinc-300 file:mr-3 file:rounded-lg file:border-0 file:bg-zinc-800 file:px-3 file:py-1.5 file:text-sm file:text-zinc-100 hover:file:bg-zinc-700"
          />
          {state.uploading && (
            <p className="text-xs text-zinc-400">Uploading to IPFS…</p>
          )}
          {state.cid && (
            <p className="flex items-center gap-1.5 break-all font-mono text-xs text-zinc-400">
              ipfs://{state.cid}
              <CopyButton value={`ipfs://${state.cid}`} label="Copy IPFS URI" />
            </p>
          )}
          <ErrorText error={state.error} className="text-xs" />
          <p className="text-xs text-zinc-500">
            PNG, JPEG, GIF, SVG or WebP up to 10 MB. Pinned on IPFS via Pinata.
          </p>
        </div>
      </div>
    </Field>
  );
}
