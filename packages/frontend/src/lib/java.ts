import type { MessageRef } from '@worldfoundry/backend/contract';
import { getCurrentDictionary } from '../i18n/current';
import type { JavaRuntime, Loader } from './types';

function parseMc(version: string): number[] | null {
  const match = /^(\d+(?:\.\d+)*)/.exec(version);
  return match?.[1] === undefined ? null : match[1].split('.').map(Number);
}

const compare = (a: readonly number[], b: readonly number[]): number => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

// Rough Java major for a Minecraft version, only used to warn before the server exists. After creating, the
// backend reports the exact value from the Mojang version data (requiredJavaMajor).
export function estimateRequiredJava(mcVersion: string): number | null {
  const parts = parseMc(mcVersion);
  if (parts === null) return null;
  if ((parts[0] ?? 0) >= 26) return 25;
  if (compare(parts, [1, 20, 5]) >= 0) return 21;
  if (compare(parts, [1, 18]) >= 0) return 17;
  if (compare(parts, [1, 17]) >= 0) return 16;
  return 8;
}

export interface JavaFit {
  fits: boolean;
  requirement: string;
}

interface Requirement {
  requiredJavaMajor: number | null;
  loader: Loader;
  mcVersion: string;
}

// Same rule as the backend: at least the version Minecraft needs, and Forge up to 1.12.2 only runs on Java 8.
export function javaFit(runtime: Pick<JavaRuntime, 'major'>, server: Requirement): JavaFit {
  const min = server.requiredJavaMajor ?? 8;
  const parts = parseMc(server.mcVersion);
  const oldForge = server.loader === 'forge' && parts !== null && (parts[0] ?? 0) < 26 && compare(parts, [1, 12, 2]) <= 0;
  const messages = getCurrentDictionary().wizard.java;
  if (oldForge) return { fits: runtime.major <= 8 && runtime.major >= min, requirement: messages.requirementRange(min) };
  return { fits: runtime.major >= min, requirement: messages.requirementMin(min) };
}

// Same rule as the backend: the lowest long-term Temurin release that satisfies the server, else the exact minimum.
const TEMURIN_LTS = [8, 11, 17, 21, 25];

export function installMajorFor(required: number, requiredMax: number | null): number | null {
  const fits = (major: number): boolean => major >= required && (requiredMax === null || major <= requiredMax);
  return TEMURIN_LTS.find(fits) ?? (fits(required) ? required : null);
}

// The Java major the server status waits for. The status carries a reference (messageRef, params.major) that is read
// first. Without it, the English text ("Installing Java 21 ...") or an older German text ("Java 21 wird installiert ...")
// is searched for the major; the text is only a fallback for statuses written before references existed.
export function preparingMajor(message: string | null, ref?: MessageRef | null): number | null {
  const major = ref?.params?.major;
  if (typeof major === 'number') return major;
  const match = message === null ? null : /\bJava (\d+)\b/.exec(message);
  return match?.[1] === undefined ? null : Number(match[1]);
}
