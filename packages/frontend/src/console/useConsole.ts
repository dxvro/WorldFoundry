import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { getCurrentDictionary } from '../i18n/current';
import { CommandError, ConsoleSession, type ConsoleSnapshot } from './session';
import { emptyConsole } from './model';

const initial = (): ConsoleSnapshot => ({ model: emptyConsole(), status: null, connection: 'connecting' });

export function useConsole(serverId: string): ConsoleSnapshot & { send: (command: string) => Promise<void> } {
  const { checkSession } = useAuth();
  const [snapshot, setSnapshot] = useState<ConsoleSnapshot>(initial);
  const session = useRef<ConsoleSession | null>(null);

  useEffect(() => {
    setSnapshot(initial());
    const next = new ConsoleSession({ serverId, onChange: setSnapshot, onRejected: () => void checkSession() });
    session.current = next;
    next.start();
    const retry = (): void => next.retryNow();
    window.addEventListener('online', retry);
    document.addEventListener('visibilitychange', retry);
    return () => {
      window.removeEventListener('online', retry);
      document.removeEventListener('visibilitychange', retry);
      next.stop();
      session.current = null;
    };
  }, [serverId, checkSession]);

  const send = useCallback(
    (command: string): Promise<void> => session.current?.send(command) ?? Promise.reject(new CommandError('NOT_CONNECTED', getCurrentDictionary().console.errors.notConnected)),
    [],
  );
  return { ...snapshot, send };
}
