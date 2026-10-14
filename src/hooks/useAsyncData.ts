"use client";

// Fetch-in-effect with the cancellation discipline every data hook needs.
// `key` identifies the inputs: the loader re-runs when it changes and is
// skipped while it is null/undefined. `reload()` re-runs for the same key
// without dropping the current data.
import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "@/lib/errors";

export interface AsyncData<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
  /** Optimistic local updates (e.g. append after an insert). */
  setData: (updater: T | null | ((prev: T | null) => T | null)) => void;
}

export function useAsyncData<T>(
  key: string | null | undefined,
  loader: () => Promise<T>,
): AsyncData<T> {
  const enabled = key !== null && key !== undefined;
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const loaderRef = useRef(loader);
  const lastKey = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    loaderRef.current = loader;
  });

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      setData(null);
      setError(null);
      lastKey.current = key;
      return;
    }
    // A new key means new inputs: drop stale data. A reload keeps it.
    if (lastKey.current !== key) setData(null);
    lastKey.current = key;

    let cancelled = false;
    setLoading(true);
    setError(null);
    loaderRef
      .current()
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(errorMessage(err, "Failed to load"));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [key, enabled, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  return { data, loading, error, reload, setData };
}
