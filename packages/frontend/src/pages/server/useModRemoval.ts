import { useCallback, useState } from 'react';
import { ApiError } from '../../lib/api';
import { modsApi } from '../../lib/endpoints';
import type { ModView, RemoveResultView } from '../../lib/types';

export interface Dependent {
  id: string;
  name: string;
}

export function dependentsFrom(error: unknown): Dependent[] {
  if (!(error instanceof ApiError) || error.code !== 'MOD_REQUIRED_BY_OTHERS') return [];
  const details = error.details as { dependents?: unknown } | undefined;
  if (!Array.isArray(details?.dependents)) return [];
  return details.dependents.filter((entry): entry is Dependent => typeof entry === 'object' && entry !== null && typeof (entry as Dependent).id === 'string' && typeof (entry as Dependent).name === 'string');
}

export type RemovalPhase = 'confirm' | 'dependents';

export interface ModRemoval {
  target: ModView | null;
  phase: RemovalPhase;
  dependents: Dependent[];
  busy: boolean;
  error: unknown;
  result: RemoveResultView | null;
  open: (mod: ModView) => void;
  cancel: () => void;
  confirm: () => Promise<void>;
  dismissResult: () => void;
}

// First attempt without force. If other mods need the target, the dialog lists them and only an
// explicit second confirmation repeats the request with force.
export function useModRemoval(serverId: string, onChanged: () => void): ModRemoval {
  const [target, setTarget] = useState<ModView | null>(null);
  const [phase, setPhase] = useState<RemovalPhase>('confirm');
  const [dependents, setDependents] = useState<Dependent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<RemoveResultView | null>(null);

  const open = useCallback((mod: ModView) => {
    setTarget(mod);
    setPhase('confirm');
    setDependents([]);
    setError(null);
    setResult(null);
  }, []);

  const cancel = useCallback(() => {
    setTarget(null);
    setError(null);
  }, []);

  const confirm = useCallback(async (): Promise<void> => {
    if (target === null) return;
    setBusy(true);
    setError(null);
    try {
      const removed = await modsApi.remove(serverId, target.id, phase === 'dependents');
      setResult(removed);
      setTarget(null);
      onChanged();
    } catch (cause) {
      const required = dependentsFrom(cause);
      if (required.length > 0 && phase === 'confirm') {
        setDependents(required);
        setPhase('dependents');
      } else {
        setError(cause);
      }
    } finally {
      setBusy(false);
    }
  }, [target, phase, serverId, onChanged]);

  const dismissResult = useCallback(() => setResult(null), []);
  return { target, phase, dependents, busy, error, result, open, cancel, confirm, dismissResult };
}
