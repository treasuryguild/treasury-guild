"use client";

// Build a treasury transaction through an /api/tx/build-* route and jump to
// its signing page. Shared by Payday and Mint. `busy` stays true through the
// navigation so the page keeps its "building" state until the signing page
// has rendered.
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api/client";
import type { BuildTxResponse } from "@/lib/api/types";
import { routes } from "@/lib/routes";
import { useAsyncAction } from "./useAsyncAction";

export function useBuildTx(slug: string) {
  const router = useRouter();
  const { run, busy, error, setError } = useAsyncAction("Failed to build transaction");
  const [isPending, startTransition] = useTransition();

  async function build<T extends BuildTxResponse>(
    path: string,
    body: unknown,
  ): Promise<T | undefined> {
    const result = await run(() => apiFetch<T>(path, { body }));
    if (result) startTransition(() => router.push(routes.tx(slug, result.txId)));
    return result;
  }

  return { build, busy: busy || isPending, error, setError };
}
