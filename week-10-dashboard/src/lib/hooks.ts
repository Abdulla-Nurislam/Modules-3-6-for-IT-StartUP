"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface Async<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

interface Settled<T> {
  /** key, для которого получен результат — чтобы не показывать данные другого адреса/сети */
  key: string | null;
  data: T | null;
  error: string | null;
}

/**
 * Runs `fn` whenever `key` changes and (optionally) every `intervalMs`.
 * `key === null` disables the query. Stale responses from a previous key are ignored,
 * and data/errors that belong to a previous key are never returned for the current one
 * (otherwise a failed request for a new address would keep showing the old address's data).
 */
export function useAsync<T>(fn: () => Promise<T>, key: string | null, intervalMs?: number): Async<T> {
  const [settled, setSettled] = useState<Settled<T>>({ key: null, data: null, error: null });
  const [loadingKey, setLoadingKey] = useState<string | null>(key);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (key === null) {
      setSettled({ key: null, data: null, error: null });
      setLoadingKey(null);
      return;
    }
    let cancelled = false;
    const run = async (initial: boolean) => {
      if (initial) setLoadingKey(key);
      try {
        const res = await fnRef.current();
        if (!cancelled) setSettled({ key, data: res, error: null });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        // keep the previous data only if it belongs to the same key (polling hiccup)
        if (!cancelled) setSettled((s) => ({ key, data: s.key === key ? s.data : null, error: message }));
      } finally {
        if (!cancelled) setLoadingKey((k) => (k === key ? null : k));
      }
    };
    run(true);
    const id = intervalMs ? setInterval(() => run(false), intervalMs) : undefined;
    return () => {
      cancelled = true;
      if (id) clearInterval(id);
    };
  }, [key, intervalMs, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const current = settled.key === key;
  return {
    data: current ? settled.data : null,
    error: current ? settled.error : null,
    loading: key !== null && (!current || loadingKey === key),
    reload,
  };
}
