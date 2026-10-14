"use client";

// busy/error state for user-triggered async work (form submits, API calls).
//   const { run, busy, error } = useAsyncAction();
//   await run(() => apiFetch(...));   // resolves undefined on failure
import { useCallback, useState } from "react";
import { describeApiError } from "@/lib/api/client";
import { MSG } from "@/lib/constants";

export interface AsyncAction {
  run: <R>(task: () => Promise<R>) => Promise<R | undefined>;
  busy: boolean;
  error: string | null;
  setError: (error: string | null) => void;
}

export function useAsyncAction(
  fallbackMessage: string = MSG.requestFailed,
): AsyncAction {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async <R,>(task: () => Promise<R>): Promise<R | undefined> => {
      setBusy(true);
      setError(null);
      try {
        return await task();
      } catch (err) {
        setError(describeApiError(err, fallbackMessage));
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [fallbackMessage],
  );

  return { run, busy, error, setError };
}
