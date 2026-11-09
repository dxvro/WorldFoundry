import { useCallback, useState } from 'react';
import { modsApi } from '../../lib/endpoints';
import type { ModView, ToggleView } from '../../lib/types';
import { dependentsFrom, type Dependent } from './useModRemoval';

export interface ModToggle {
  // the mod waiting in the dialog because other mods still need it
  pending: ModView | null;
  dependents: Dependent[];
  // id of the mod whose request is running
  busyId: string | null;
  error: unknown;
  result: { enabled: boolean; data: ToggleView } | null;
  toggle: (mod: ModView, enabled: boolean) => Promise<void>;
  confirmForce: () => Promise<void>;
  cancel: () => void;
  dismissResult: () => void;
}

// Switching off first asks without force. If other enabled mods need the target, a dialog lists them and only
// a second confirmation repeats the request with force. Switching on needs no question: the backend switches
// on the required dependencies as well and reports them in the result.
export function useModToggle(serverId: string, onChanged: () => void): ModToggle {
  const [pending, setPending] = useState<ModView | null>(null);
  const [dependents, setDependents] = useState<Dependent[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<ModToggle['result']>(null);

  const send = useCallback(
    async (mod: ModView, enabled: boolean, force: boolean): Promise<void> => {
      setBusyId(mod.id);
      setError(null);
      try {
        const data = await modsApi.setEnabled(serverId, mod.id, enabled, force);
        setResult({ enabled, data });
        setPending(null);
        onChanged();
      } catch (cause) {
        const required = dependentsFrom(cause);
        if (required.length > 0 && !force) {
          setPending(mod);
          setDependents(required);
        } else {
          setPending(null);
          setError(cause);
        }
      } finally {
        setBusyId(null);
      }
    },
    [serverId, onChanged],
  );

  const toggle = useCallback(
    (mod: ModView, enabled: boolean): Promise<void> => {
      setResult(null);
      return send(mod, enabled, false);
    },
    [send],
  );
  const confirmForce = useCallback(async (): Promise<void> => {
    if (pending !== null) await send(pending, false, true);
  }, [pending, send]);
  const cancel = useCallback(() => setPending(null), []);
  const dismissResult = useCallback(() => setResult(null), []);
  return { pending, dependents, busyId, error, result, toggle, confirmForce, cancel, dismissResult };
}
