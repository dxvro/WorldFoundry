import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react';
import { getCurrentDictionary } from '../i18n/current';
import { ApiError, isAbort } from './api';

export interface QueryState<T> {
  data: T | undefined;
  error: ApiError | Error | null;
  loading: boolean;
  reload: () => void;
  setData: (data: T) => void;
}

// Loads on mount and whenever deps change; a newer request makes older ones irrelevant (aborted and ignored).
export function useQuery<T>(load: (signal: AbortSignal) => Promise<T>, deps: DependencyList, enabled = true): QueryState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  const lastTick = useRef(0);
  loadRef.current = load;

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    // other inputs mean other data: do not show the previous answer; a plain reload keeps it visible
    if (tick === lastTick.current) setData(undefined);
    lastTick.current = tick;
    setError(null);
    setLoading(true);
    loadRef
      .current(controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setData(result);
        setError(null);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || isAbort(cause)) return;
        setError(cause instanceof Error ? cause : new Error(getCurrentDictionary().common.unknownError));
        setLoading(false);
      });
    return () => controller.abort();
  }, [...deps, tick, enabled]);

  const reload = useCallback(() => setTick((value) => value + 1), []);
  return { data, error, loading, reload, setData };
}
