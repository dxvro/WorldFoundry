import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { describeError, isAbort } from '../lib/api';
import { serversApi, updateApi } from '../lib/endpoints';
import { ReconnectingSocket, websocketUrl } from '../lib/socket';
import type { EventsServerMessage, RuntimeStatus, ServerView, SystemUpdateState } from '../lib/types';
import { initialLiveState, liveReducer, needsRefetch, statusOf, type LiveState } from './reducer';

interface LiveContextValue {
  state: LiveState;
  listError: string | null;
  statusFor: (server: ServerView) => RuntimeStatus;
  refresh: () => Promise<void>;
  setRestartNeeded: (serverId: string, needed: boolean) => void;
  // takes over an answer of the update API (the events deliver later changes)
  setUpdate: (update: SystemUpdateState) => void;
  // reads install.log and merges it with the lines that already arrived as events
  loadInstallLog: (serverId: string) => Promise<{ truncated: boolean }>;
}

const LiveContext = createContext<LiveContextValue | null>(null);

const REFETCH_DELAY_MS = 150;

function isEventsMessage(value: unknown): value is EventsServerMessage {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}

export function LiveProvider({ children }: { children: ReactNode }): ReactNode {
  const { checkSession } = useAuth();
  const [state, dispatch] = useReducer(liveReducer, undefined, initialLiveState);
  const [listError, setListError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const updateEvents = useRef(0);

  const refreshUpdate = useCallback(async (): Promise<void> => {
    // an event that arrives while the answer is on its way is newer than the answer
    const seen = updateEvents.current;
    try {
      const update = await updateApi.state();
      if (seen === updateEvents.current && typeof update?.phase === 'string') dispatch({ type: 'update', update });
    } catch {
      // the banner is optional: without an answer there is simply none
    }
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const servers = await serversApi.list(controller.signal);
      dispatch({ type: 'servers', servers });
      setListError(null);
    } catch (error) {
      if (!isAbort(error)) setListError(describeError(error));
    }
  }, []);

  useEffect(() => {
    const scheduleRefetch = (): void => {
      if (refetchTimer.current !== null) clearTimeout(refetchTimer.current);
      refetchTimer.current = setTimeout(() => void refresh(), REFETCH_DELAY_MS);
    };
    const socket = new ReconnectingSocket({
      url: () => websocketUrl('/api/events'),
      onState: (connection) => dispatch({ type: 'connection', connection }),
      // events may have been missed while the socket was down, so the list is read again on every open
      onOpen: () => {
        void refresh();
        void refreshUpdate();
      },
      onRejected: () => void checkSession(),
      onMessage: (message) => {
        if (!isEventsMessage(message)) return;
        if (message.type === 'update.state') updateEvents.current += 1;
        dispatch({ type: 'message', message });
        if (needsRefetch(message)) scheduleRefetch();
      },
    });
    socket.start();
    void refresh();
    void refreshUpdate();
    const retry = (): void => socket.retryNow();
    window.addEventListener('online', retry);
    document.addEventListener('visibilitychange', retry);
    return () => {
      window.removeEventListener('online', retry);
      document.removeEventListener('visibilitychange', retry);
      if (refetchTimer.current !== null) clearTimeout(refetchTimer.current);
      abortRef.current?.abort();
      socket.stop();
    };
  }, [refresh, refreshUpdate, checkSession]);

  const setRestartNeeded = useCallback((serverId: string, needed: boolean) => dispatch({ type: 'restart-needed', serverId, needed }), []);
  const loadInstallLog = useCallback(async (serverId: string): Promise<{ truncated: boolean }> => {
    const view = await serversApi.installLog(serverId, 500);
    dispatch({ type: 'install-log', serverId, lines: view.lines });
    return { truncated: view.truncated };
  }, []);
  const setUpdate = useCallback((update: SystemUpdateState) => dispatch({ type: 'update', update }), []);
  const statusFor = useCallback((server: ServerView) => statusOf(state, server), [state]);
  const value = useMemo<LiveContextValue>(
    () => ({ state, listError, statusFor, refresh, setRestartNeeded, setUpdate, loadInstallLog }),
    [state, listError, statusFor, refresh, setRestartNeeded, setUpdate, loadInstallLog],
  );
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export function useLive(): LiveContextValue {
  const value = useContext(LiveContext);
  if (value === null) throw new Error('useLive muss innerhalb von LiveProvider verwendet werden.');
  return value;
}
