import type { Loader } from '../db/enums.js';
import { msg, type MessageRef, type Msg } from '../messages.js';
import { mcAtMost } from '../installer/mc-version.js';

export interface JavaRuntime {
  path: string;
  major: number;
  version: string;
  name: string;
  source: 'JAVA_HOME' | 'PATH' | 'standard' | 'manual' | 'managed';
  // plain-language origin of a runtime WorldFoundry installed itself, null for everything else
  origin: string | null;
  // key and params for `origin`; only present together with an origin
  originRef?: MessageRef;
}

export interface JavaRequirement {
  min: number;
  max: number | null;
  note: Msg | null;
}

// Forge up to 1.12.2 (LaunchWrapper) cannot run on Java 9+. For 1.13-1.16.5 no hard limit could be
// verified, so that range only produces a warning
export function javaRequirement(loader: Loader, mcVersion: string, requiredMajor: number | null): JavaRequirement {
  const min = requiredMajor ?? 8;
  if (loader === 'forge' && mcAtMost(mcVersion, 1, 12, 2)) return { min, max: 8, note: null };
  if (loader === 'forge' && mcAtMost(mcVersion, 1, 16, 5)) {
    return { min, max: null, note: msg('JAVA_FORGE_OLD_NOTE') };
  }
  return { min, max: null, note: null };
}

export const meetsRequirement = (major: number, requirement: JavaRequirement): boolean =>
  major >= requirement.min && (requirement.max === null || major <= requirement.max);

// lowest suitable major first: the closest match to what the server was built for
export function chooseRuntime(runtimes: readonly JavaRuntime[], requirement: JavaRequirement): JavaRuntime | null {
  const suitable = runtimes.filter((runtime) => meetsRequirement(runtime.major, requirement));
  return suitable.sort((a, b) => a.major - b.major || a.path.localeCompare(b.path))[0] ?? null;
}

// Feature releases Eclipse Temurin supports long term. A missing runtime is installed as the lowest of these
// that satisfies the requirement (Minecraft's Java 16 becomes 17); beyond the last one the exact minimum is used.
export const TEMURIN_LTS: readonly number[] = [8, 11, 17, 21, 25];

export function pickInstallMajor(requirement: JavaRequirement): number | null {
  const lts = TEMURIN_LTS.find((major) => meetsRequirement(major, requirement));
  if (lts !== undefined) return lts;
  return meetsRequirement(requirement.min, requirement) ? requirement.min : null;
}
