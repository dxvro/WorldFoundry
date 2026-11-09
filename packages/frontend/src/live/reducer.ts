import { getCurrentDictionary } from '../i18n/current';
import type { ConnectionState } from '../lib/socket';
import type { MessageRef } from '@worldfoundry/backend/contract';
import type { AppEvent, EventsServerMessage, InstallLogLine, InstallState, RuntimeStatus, ServerView, SystemUpdateState } from '../lib/types';

export const MAX_INSTALL_LOG_LINES = 400;

export const offlineStatus = (): RuntimeStatus => ({
  state: 'offline',
  pid: null,
  startedAt: null,
  exitCode: null,
  message: null,
  messageRef: null,
  players: [],
  port: null,
  cpuPercent: null,
  rssBytes: null,
});

export interface InstallLogEntry {
  // line number in install.log; the same number comes with the live event of that line
  seq: number;
  time: number | null;
  text: string;
}

export interface InstallProgress {
  phase: string;
  percent: number | null;
  message: string;
  messageRef: MessageRef | null;
  log: InstallLogEntry[];
}

export interface JavaInstallProgress {
  state: 'running' | 'done' | 'failed';
  phase: string;
  percent: number | null;
  message: string;
  messageRef: MessageRef | null;
  error: string | null;
  errorRef: MessageRef | null;
}

// Union by line number: lines loaded from the file and lines that arrived as events never double up.
export function mergeInstallLog(current: readonly InstallLogEntry[], incoming: readonly InstallLogEntry[]): InstallLogEntry[] {
  const bySeq = new Map<number, InstallLogEntry>();
  for (const entry of current) bySeq.set(entry.seq, entry);
  for (const entry of incoming) bySeq.set(entry.seq, entry);
  const merged = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  return merged.length > MAX_INSTALL_LOG_LINES ? merged.slice(-MAX_INSTALL_LOG_LINES) : merged;
}

// Where the loaded file and the live lines do not join up, lines are missing in between.
export function hasLogGap(log: readonly InstallLogEntry[]): boolean {
  return log.some((entry, index) => index > 0 && entry.seq !== (log[index - 1] as InstallLogEntry).seq + 1);
}

export interface CrashInfo {
  exitCode: number | null;
  lastLines: string[];
  // parallel to lastLines: the reference of a system line, null for the server's own output (absent in older events)
  lastLinesRefs?: Array<MessageRef | null>;
}

export interface ModUpdateInfo {
  ok: boolean;
  count: number;
  projects: string[];
  error: string | null;
  errorRef: MessageRef | null;
}

export interface LiveState {
  connection: ConnectionState;
  // true once the event stream delivered a snapshot, from then on missing servers are offline
  snapshotSeen: boolean;
  servers: ServerView[] | null;
  statuses: Record<string, RuntimeStatus>;
  installs: Record<string, InstallProgress>;
  javaInstalls: Record<number, JavaInstallProgress>;
  backupTicks: Record<string, number>;
  crashes: Record<string, CrashInfo>;
  modUpdates: Record<string, ModUpdateInfo>;
  restartNeeded: Record<string, boolean>;
  // self-update of WorldFoundry; null until the first answer
  update: SystemUpdateState | null;
}

export const initialLiveState = (): LiveState => ({
  connection: 'connecting',
  snapshotSeen: false,
  servers: null,
  statuses: {},
  installs: {},
  javaInstalls: {},
  backupTicks: {},
  crashes: {},
  modUpdates: {},
  restartNeeded: {},
  update: null,
});

export type LiveAction =
  | { type: 'connection'; connection: ConnectionState }
  | { type: 'servers'; servers: ServerView[] }
  | { type: 'message'; message: EventsServerMessage }
  | { type: 'restart-needed'; serverId: string; needed: boolean }
  | { type: 'install-log'; serverId: string; lines: InstallLogLine[] }
  | { type: 'update'; update: SystemUpdateState };

const without = <T>(record: Record<string, T>, key: string): Record<string, T> => {
  const { [key]: _removed, ...rest } = record;
  return rest;
};

function patchServer(servers: ServerView[] | null, serverId: string, patch: Partial<ServerView>): ServerView[] | null {
  if (servers === null) return servers;
  return servers.map((server) => (server.id === serverId ? { ...server, ...patch } : server));
}

function reduceEvent(state: LiveState, event: AppEvent): LiveState {
  switch (event.type) {
    case 'server.status': {
      const next: LiveState = { ...state, statuses: { ...state.statuses, [event.serverId]: event.status } };
      if (event.status.state === 'starting' || event.status.state === 'preparing') {
        next.crashes = without(state.crashes, event.serverId);
        next.restartNeeded = without(state.restartNeeded, event.serverId);
      }
      return next;
    }
    case 'server.metrics': {
      const current = state.statuses[event.serverId];
      if (current === undefined) return state;
      return {
        ...state,
        statuses: { ...state.statuses, [event.serverId]: { ...current, cpuPercent: event.cpuPercent, rssBytes: event.rssBytes } },
      };
    }
    case 'server.crashed':
      return { ...state, crashes: { ...state.crashes, [event.serverId]: { exitCode: event.exitCode, lastLines: event.lastLines, lastLinesRefs: event.lastLinesRefs } } };
    case 'server.changed':
      if (event.reason !== 'deleted') return state;
      return {
        ...state,
        servers: state.servers === null ? null : state.servers.filter((server) => server.id !== event.serverId),
        statuses: without(state.statuses, event.serverId),
        installs: without(state.installs, event.serverId),
        backupTicks: without(state.backupTicks, event.serverId),
        crashes: without(state.crashes, event.serverId),
        modUpdates: without(state.modUpdates, event.serverId),
        restartNeeded: without(state.restartNeeded, event.serverId),
      };
    case 'install.state': {
      // a new run appends to the same install.log, so the lines stay and only the progress starts over
      const installs =
        event.installState === 'installing'
          ? { ...state.installs, [event.serverId]: { phase: 'resolve', percent: null, message: getCurrentDictionary().console.live.installStarting, messageRef: null, log: state.installs[event.serverId]?.log ?? [] } }
          : state.installs;
      return {
        ...state,
        installs,
        servers: patchServer(state.servers, event.serverId, { installState: event.installState as InstallState, installError: event.installError, installErrorRef: event.installErrorRef }),
      };
    }
    case 'install.progress': {
      const previous = state.installs[event.serverId];
      return {
        ...state,
        installs: {
          ...state.installs,
          [event.serverId]: { phase: event.phase, percent: event.percent, message: event.message, messageRef: event.messageRef, log: previous?.log ?? [] },
        },
      };
    }
    case 'install.log': {
      const previous = state.installs[event.serverId] ?? { phase: 'resolve', percent: null, message: '', messageRef: null, log: [] };
      const entry: InstallLogEntry = { seq: event.seq, time: event.time, text: event.line };
      return {
        ...state,
        installs: { ...state.installs, [event.serverId]: { ...previous, log: mergeInstallLog(previous.log, [entry]) } },
      };
    }
    case 'java.install': {
      const javaInstalls = {
        ...state.javaInstalls,
        [event.major]: { state: event.state, phase: event.phase, percent: event.percent, message: event.message, messageRef: event.messageRef, error: event.error, errorRef: event.errorRef },
      };
      return { ...state, javaInstalls };
    }
    case 'backup.changed': {
      return { ...state, backupTicks: { ...state.backupTicks, [event.serverId]: (state.backupTicks[event.serverId] ?? 0) + 1 } };
    }
    case 'update.state':
      return { ...state, update: event.state };
    case 'system.restarting':
      // the restart panel of the system page follows the answer of the API, not this event
      return state;
    case 'mods.updates':
      return {
        ...state,
        modUpdates: { ...state.modUpdates, [event.serverId]: { ok: event.ok, count: event.count, projects: event.projects, error: event.error, errorRef: event.errorRef } },
      };
  }
}

export function liveReducer(state: LiveState, action: LiveAction): LiveState {
  switch (action.type) {
    case 'connection':
      return { ...state, connection: action.connection };
    case 'servers':
      return { ...state, servers: action.servers };
    case 'update':
      return { ...state, update: action.update };
    case 'install-log': {
      const previous = state.installs[action.serverId] ?? { phase: 'resolve', percent: null, message: '', messageRef: null, log: [] };
      const loaded = action.lines.map((line): InstallLogEntry => ({ seq: line.seq, time: line.time, text: line.text }));
      return { ...state, installs: { ...state.installs, [action.serverId]: { ...previous, log: mergeInstallLog(previous.log, loaded) } } };
    }
    case 'restart-needed':
      return {
        ...state,
        restartNeeded: action.needed ? { ...state.restartNeeded, [action.serverId]: true } : without(state.restartNeeded, action.serverId),
      };
    case 'message': {
      const message = action.message;
      switch (message.type) {
        case 'snapshot':
          return {
            ...state,
            snapshotSeen: true,
            statuses: Object.fromEntries(message.servers.map((entry) => [entry.serverId, entry.status])),
          };
        case 'pong':
        case 'error':
          return state;
        default:
          return reduceEvent(state, message);
      }
    }
  }
}

export function statusOf(state: LiveState, server: ServerView): RuntimeStatus {
  const live = state.statuses[server.id];
  if (live !== undefined) return live;
  return state.snapshotSeen ? offlineStatus() : server.status;
}

// Events after which the server list must be read again because the list itself changed.
export function needsRefetch(message: EventsServerMessage): boolean {
  if (message.type === 'server.changed') return message.reason !== 'deleted';
  if (message.type === 'install.state') return message.installState === 'installed' || message.installState === 'failed';
  return false;
}
