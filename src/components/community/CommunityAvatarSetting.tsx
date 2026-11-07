"use client";

// Admin-only profile picture on the Members Community card. Upload goes
// through the mint Pinata path; binding the CID is a community PATCH.
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import type { ImageState } from "@/lib/mint/types";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useIpfsGateway } from "@/hooks/useIpfsGateway";
import { ImageUpload } from "@/components/mint/ImageUpload";
import { Button, ErrorText, NoticeText } from "@/components/ui";

const EMPTY: ImageState = {
  cid: null,
  mediaType: null,
  fileName: null,
  uploading: false,
  error: null,
};

export function CommunityAvatarSetting({
  communityId,
  avatarCid,
  onSaved,
}: {
  communityId: string;
  avatarCid: string | null;
  onSaved: () => void;
}) {
  const gateway = useIpfsGateway();
  const [image, setImage] = useState<ImageState>(() =>
    avatarCid ? { ...EMPTY, cid: avatarCid } : EMPTY,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const action = useAsyncAction();

  useEffect(() => {
    setImage(avatarCid ? { ...EMPTY, cid: avatarCid } : EMPTY);
  }, [avatarCid]);

  async function bind(cid: string | null) {
    setNotice(null);
    const ok = await action.run(() =>
      apiFetch("/api/community", {
        method: "PATCH",
        body: { communityId, avatarCid: cid },
      }),
    );
    if (!ok) return;
    setNotice(cid ? "Profile picture saved." : "Profile picture removed.");
    onSaved();
  }

  function onChange(next: ImageState) {
    const prevCid = image.cid;
    setImage(next);
    if (next.cid && next.cid !== prevCid && !next.uploading && !next.error) {
      void bind(next.cid);
    }
  }

  return (
    <div className="mt-4 border-t border-zinc-800 pt-4">
      <ImageUpload
        communityId={communityId}
        state={image}
        gateway={gateway}
        onChange={onChange}
        label="Profile picture"
        rounded
        disabled={action.busy}
      />
      {image.cid && (
        <Button
          type="button"
          variant="secondary"
          className="mt-2"
          disabled={action.busy || image.uploading}
          onClick={() => {
            setImage(EMPTY);
            void bind(null);
          }}
        >
          Remove
        </Button>
      )}
      <ErrorText error={action.error} className="mt-2 text-xs" />
      <NoticeText className="mt-2 text-xs">{notice}</NoticeText>
      <p className="mt-2 text-xs text-zinc-500">
        Shown on community lists and Discord announcements. Images are public and
        permanent on IPFS; removing only unlinks them here.
      </p>
    </div>
  );
}
