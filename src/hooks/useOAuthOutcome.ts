"use client";

import { useEffect, useState } from "react";

export interface OAuthOutcome {
  outcome: string | null;
  /** The short failure code the callback added (?reason=…). */
  reason: string | null;
  clear: () => void;
}

/**
 * The outcome an OAuth round trip came back with: the callback redirects to
 * the page that started it with ?<param>=<outcome>&reason=<code>. Read once
 * on mount; the reason counts only when this flow's outcome is present.
 */
export function useOAuthOutcome(param: string): OAuthOutcome {
  const [outcome, setOutcome] = useState<string | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  useEffect(() => {
    const search = new URLSearchParams(window.location.search);
    const value = search.get(param);
    setOutcome(value);
    setReason(value ? search.get("reason") : null);
  }, [param]);
  return { outcome, reason, clear: () => setOutcome(null) };
}
