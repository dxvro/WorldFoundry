import { getCurrentDictionary } from '../i18n/current';
import type { SelfUpdateResult, SystemUpdateState, UpdatePhase } from './types';

// Labels follow the active language; read at call time, so call these from components that use useI18n().
export const phaseLabel = (phase: UpdatePhase): string => getCurrentDictionary().update.phases[phase];
export const resultLabel = (result: SelfUpdateResult): string => getCurrentDictionary().update.results[result];

// the steps in order, for the progress list
export const STEPS: UpdatePhase[] = ['downloading', 'verifying', 'waiting-for-servers', 'installing', 'restarting'];

export const isRunning = (state: SystemUpdateState): boolean => state.phase !== 'idle' && state.phase !== 'done' && state.phase !== 'failed';

// the banner is wanted whenever there is something to say
export function bannerKind(state: SystemUpdateState | null): 'available' | 'running' | 'done' | 'failed' | null {
  if (state === null) return null;
  if (isRunning(state)) return 'running';
  if (state.phase === 'done') return 'done';
  if (state.phase === 'failed') return 'failed';
  return state.updateAvailable ? 'available' : null;
}

export const COUNTDOWN_MAX = 600;
