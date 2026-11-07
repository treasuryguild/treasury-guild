// Derived person avatars: GitHub CDN when a login is known, otherwise a
// letter mark with a stable hue. Client-safe; no uploads, nothing stored.

export function githubAvatarUrl(login: string, size = 96): string {
  const clean = login.trim().replace(/^@/, "");
  return `https://avatars.githubusercontent.com/${encodeURIComponent(clean)}?s=${size}`;
}

/** Letter shown when there is no (or a failed) GitHub photo. */
export function personInitial(input: {
  handle?: string | null;
  githubUsername?: string | null;
  wallet?: string | null;
  /** Capture / display name when no wallet or profile exists. */
  displayName?: string | null;
}): string {
  const handle = input.handle?.trim();
  if (handle) return handle.charAt(0).toUpperCase();
  const gh = input.githubUsername?.trim().replace(/^@/, "");
  if (gh) return gh.charAt(0).toUpperCase();
  const display = input.displayName?.trim();
  if (display) return display.charAt(0).toUpperCase();
  const wallet = input.wallet?.trim();
  if (wallet) return wallet.charAt(0).toUpperCase();
  return "?";
}

/** Stable hue 0–359 from a wallet address or GitHub login. */
export function personHue(seed: string | null | undefined): number {
  const s = (seed ?? "").trim().toLowerCase();
  if (!s) return 220;
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return h % 360;
}

export function personMarkStyle(seed: string | null | undefined): {
  backgroundColor: string;
  color: string;
} {
  const hue = personHue(seed);
  return {
    backgroundColor: `hsl(${hue} 35% 22%)`,
    color: `hsl(${hue} 40% 78%)`,
  };
}
