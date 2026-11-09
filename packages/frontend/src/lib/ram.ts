import { getCurrentDictionary } from '../i18n/current';

// Mirrors MIN_RAM_MB of the backend (servers/schemas.ts); the backend stays the authority and re-checks.
export const MIN_RAM_MB = 256;
export const RAM_STEP_MB = 128;
export const DEFAULT_MIN_RAM_MB = 1024;
export const DEFAULT_MAX_RAM_MB = 2048;

export interface RamPair {
  minRamMb: number;
  maxRamMb: number;
}

export interface RamBounds {
  min: number;
  max: number;
  step: number;
}

// The slider never offers more than the machine has; below two steps of memory the bounds collapse to one value.
export function ramBounds(totalMemoryMb: number): RamBounds {
  const max = Math.max(MIN_RAM_MB, Math.floor(totalMemoryMb / RAM_STEP_MB) * RAM_STEP_MB);
  return { min: MIN_RAM_MB, max: Math.min(max, Math.max(MIN_RAM_MB, totalMemoryMb)), step: RAM_STEP_MB };
}

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));
const snap = (value: number, bounds: RamBounds): number =>
  clamp(Math.round(value / bounds.step) * bounds.step, bounds.min, bounds.max);

export function defaultRam(totalMemoryMb: number): RamPair {
  const bounds = ramBounds(totalMemoryMb);
  const maxRamMb = Math.min(DEFAULT_MAX_RAM_MB, bounds.max);
  return { minRamMb: Math.min(DEFAULT_MIN_RAM_MB, maxRamMb), maxRamMb };
}

// Moving one handle past the other drags the other one along, so min <= max always holds.
export function withMin(pair: RamPair, value: number, bounds: RamBounds): RamPair {
  const minRamMb = snap(value, bounds);
  return { minRamMb, maxRamMb: Math.max(pair.maxRamMb, minRamMb) };
}

export function withMax(pair: RamPair, value: number, bounds: RamBounds): RamPair {
  const maxRamMb = snap(value, bounds);
  return { minRamMb: Math.min(pair.minRamMb, maxRamMb), maxRamMb };
}

export function validateRam(pair: RamPair, totalMemoryMb: number): { minRamMb?: string; maxRamMb?: string } {
  const messages = getCurrentDictionary().wizard.ram;
  const errors: { minRamMb?: string; maxRamMb?: string } = {};
  if (!Number.isInteger(pair.minRamMb) || pair.minRamMb < MIN_RAM_MB) errors.minRamMb = messages.minimum(MIN_RAM_MB);
  if (!Number.isInteger(pair.maxRamMb) || pair.maxRamMb < MIN_RAM_MB) errors.maxRamMb = messages.minimum(MIN_RAM_MB);
  if (errors.minRamMb === undefined && errors.maxRamMb === undefined && pair.minRamMb > pair.maxRamMb) {
    errors.minRamMb = messages.minAboveMax;
  }
  if (errors.maxRamMb === undefined && pair.maxRamMb > totalMemoryMb) {
    errors.maxRamMb = messages.machineTooSmall(totalMemoryMb);
  }
  return errors;
}

// true when the maximum would leave less than a quarter of the machine to everything else
export const isRamTight = (pair: RamPair, totalMemoryMb: number): boolean => pair.maxRamMb > totalMemoryMb * 0.75;
