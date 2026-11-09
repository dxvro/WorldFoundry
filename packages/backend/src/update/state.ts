import type { UpdatePhase } from './types.js';

// The phases of one update run and the only moves between them. Everything else is a programming error.
export type UpdateEvent =
  | 'start' // admin confirmed
  | 'downloaded'
  | 'verified'
  | 'servers-stopped'
  | 'handed-over' // request written, the privileged updater takes over
  | 'restarting' // the service goes down for the installation
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'dismiss';

const TRANSITIONS: Record<UpdatePhase, Partial<Record<UpdateEvent, UpdatePhase>>> = {
  idle: { start: 'downloading' },
  downloading: { downloaded: 'verifying', failed: 'failed', cancelled: 'idle' },
  verifying: { verified: 'waiting-for-servers', failed: 'failed', cancelled: 'idle' },
  'waiting-for-servers': { 'servers-stopped': 'installing', failed: 'failed', cancelled: 'idle' },
  installing: { 'handed-over': 'installing', restarting: 'restarting', succeeded: 'done', failed: 'failed' },
  restarting: { succeeded: 'done', failed: 'failed' },
  // a finished run can be dismissed or followed directly by the next one
  done: { dismiss: 'idle', start: 'downloading' },
  failed: { dismiss: 'idle', start: 'downloading' },
};

export class IllegalTransition extends Error {
  constructor(
    readonly phase: UpdatePhase,
    readonly event: UpdateEvent,
  ) {
    super(`Invalid transition "${event}" in state "${phase}".`);
    this.name = 'IllegalTransition';
  }
}

export function nextPhase(phase: UpdatePhase, event: UpdateEvent): UpdatePhase {
  const next = TRANSITIONS[phase][event];
  if (next === undefined) throw new IllegalTransition(phase, event);
  return next;
}

export function canTransition(phase: UpdatePhase, event: UpdateEvent): boolean {
  return TRANSITIONS[phase][event] !== undefined;
}

// A run is in progress: no second update, no new check
export const isBusy = (phase: UpdatePhase): boolean => phase !== 'idle' && phase !== 'done' && phase !== 'failed';

// From the moment servers are stopped until the new version is up, nothing may start or change servers
export const isBlockingPhase = (phase: UpdatePhase): boolean => phase === 'waiting-for-servers' || phase === 'installing' || phase === 'restarting';

export const PHASE_LABELS: Record<UpdatePhase, string> = {
  idle: 'Ready',
  downloading: 'Downloading update',
  verifying: 'Verifying signature and checksum',
  'waiting-for-servers': 'Warning and stopping servers',
  installing: 'Installing update',
  restarting: 'WorldFoundry is restarting',
  done: 'Update finished',
  failed: 'Update failed',
};
