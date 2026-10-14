"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import type { OAuthRequestResponse } from "@/lib/api/types";
import { useAsyncData, type AsyncData } from "./useAsyncData";

export interface ConsentRequest {
  /** The signed authorization-request handle (?request=), null until read or when absent. */
  handle: string | null;
  /** The refusal code /api/oauth/authorize sent before a handle existed (?error=); show it only through consentErrorMessage. */
  refusal: string | null;
  /** False until the query string has been read (first client render). */
  ready: boolean;
  info: AsyncData<OAuthRequestResponse>;
}

/** The consent page's request: read once from the query string, described by /api/oauth/request. */
export function useConsentRequest(): ConsentRequest {
  const [query, setQuery] = useState<{ handle: string | null; refusal: string | null } | null>(null);
  useEffect(() => {
    const search = new URLSearchParams(window.location.search);
    setQuery({ handle: search.get("request"), refusal: search.get("error") });
  }, []);
  const handle = query?.handle ?? null;
  const info = useAsyncData(handle, () =>
    apiFetch<OAuthRequestResponse>("/api/oauth/request", { query: { request: handle } }),
  );
  return { handle, refusal: query?.refusal ?? null, ready: query !== null, info };
}
