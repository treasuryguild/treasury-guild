"use client";

import { useState } from "react";
import { ipfsUrl } from "@/lib/ipfs";
import { useIpfsGateway } from "@/hooks/useIpfsGateway";

const SIZES = {
  sm: "h-6 w-6 text-[10px]",
  md: "h-8 w-8 text-xs",
  lg: "h-10 w-10 text-sm",
  xl: "h-14 w-14 text-lg",
} as const;

export type CommunityAvatarSize = keyof typeof SIZES;

/** Circular community profile picture, or a letter fallback when unset. */
export function CommunityAvatar({
  name,
  avatarCid,
  size = "md",
  className = "",
}: {
  name: string;
  avatarCid: string | null | undefined;
  size?: CommunityAvatarSize;
  className?: string;
}) {
  const gateway = useIpfsGateway();
  const [failed, setFailed] = useState(false);
  const src = avatarCid && gateway && !failed ? ipfsUrl(gateway, avatarCid) : null;
  const letter = (name.trim().charAt(0) || "?").toUpperCase();
  const box = `inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-zinc-700 bg-zinc-900 font-medium text-zinc-300 ${SIZES[size]} ${className}`;

  if (!src) {
    return (
      <span className={box} aria-hidden="true">
        {letter}
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      className={`${box} object-cover`}
      onError={() => setFailed(true)}
    />
  );
}
