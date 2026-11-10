// 'preparing' is the phase before the process exists: a missing Java runtime is being installed
import type { MessageRef } from '../messages.js';

export const SERVER_STATES = ['offline', 'preparing', 'starting', 'online', 'stopping', 'crashed'] as const;
export type ServerState = (typeof SERVER_STATES)[number];

export interface RuntimeStatus {
  state: ServerState;
  pid: number | null;
  startedAt: number | null;
  exitCode: number | null;
  message: string | null;
  // key and params for `message`; null when the text has no key (older code paths, text of the server itself)
  messageRef: MessageRef | null;
  players: string[];
  port: number | null;
  cpuPercent: number | null;
  rssBytes: number | null;
  // players online when the game reports a number but no names (Satisfactory); null when unknown
  playerCount?: number | null;
}

export type ConsoleStream = 'stdout' | 'stderr' | 'system' | 'input';

export interface ConsoleLine {
  seq: number;
  time: number;
  stream: ConsoleStream;
  text: string;
  // key and params for `text`; only set on 'system' lines that WorldFoundry writes itself
  textRef?: MessageRef;
}

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
