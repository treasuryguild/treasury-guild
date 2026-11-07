"use client";

import { useState } from "react";
import {
  githubAvatarUrl,
  personInitial,
  personMarkStyle,
} from "@/lib/personAvatar";

const SIZES = {
  sm: "h-6 w-6 text-[10px]",
  md: "h-8 w-8 text-xs",
  lg: "h-10 w-10 text-sm",
  xl: "h-14 w-14 text-lg",
} as const;

export type PersonAvatarSize = keyof typeof SIZES;

/**
 * Decorative person mark: GitHub CDN photo when a login is known, otherwise
 * a letter on a deterministic hue. Name stays in adjacent text.
 */
export function PersonAvatar({
  wallet,
  handle,
  githubUsername,
  displayName,
  size = "md",
  className = "",
}: {
  wallet?: string | null;
  handle?: string | null;
  githubUsername?: string | null;
  displayName?: string | null;
  size?: PersonAvatarSize;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const login = githubUsername?.trim().replace(/^@/, "") || null;
  const src = login && !failed ? githubAvatarUrl(login) : null;
  const letter = personInitial({ handle, githubUsername: login, wallet, displayName });
  const seed = wallet?.trim() || login || handle?.trim() || displayName?.trim() || "";
  const mark = personMarkStyle(seed);
  const box = `inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-zinc-700 font-medium ${SIZES[size]} ${className}`;

  if (!src) {
    return (
      <span className={box} style={mark} aria-hidden="true">
        {letter}
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      className={`${box} bg-zinc-900 object-cover`}
      aria-hidden="true"
      onError={() => setFailed(true)}
    />
  );
}
