import { compareNumeric, parseMcVersion } from '../installer/mc-version.js';

// DataVersion (the world format number Minecraft writes into level.dat since 15w32a) of the release versions.
// Used when level.dat carries a DataVersion but no readable version name, and to tell an older world from a
// newer one. Versions after the end of this table (the year-based 26.x line) fall back to comparing names.
const RELEASES: ReadonlyArray<readonly [string, number]> = [
  ['1.9', 169],
  ['1.9.1', 175],
  ['1.9.2', 176],
  ['1.9.4', 184],
  ['1.10', 510],
  ['1.10.1', 511],
  ['1.10.2', 512],
  ['1.11', 819],
  ['1.11.1', 921],
  ['1.11.2', 922],
  ['1.12', 1139],
  ['1.12.1', 1241],
  ['1.12.2', 1343],
  ['1.13', 1519],
  ['1.13.1', 1628],
  ['1.13.2', 1631],
  ['1.14', 1952],
  ['1.14.1', 1957],
  ['1.14.2', 1963],
  ['1.14.3', 1968],
  ['1.14.4', 1976],
  ['1.15', 2225],
  ['1.15.1', 2227],
  ['1.15.2', 2230],
  ['1.16', 2566],
  ['1.16.1', 2567],
  ['1.16.2', 2578],
  ['1.16.3', 2580],
  ['1.16.4', 2584],
  ['1.16.5', 2586],
  ['1.17', 2724],
  ['1.17.1', 2730],
  ['1.18', 2860],
  ['1.18.1', 2865],
  ['1.18.2', 2975],
  ['1.19', 3105],
  ['1.19.1', 3117],
  ['1.19.2', 3120],
  ['1.19.3', 3218],
  ['1.19.4', 3337],
  ['1.20', 3463],
  ['1.20.1', 3465],
  ['1.20.2', 3578],
  ['1.20.3', 3698],
  ['1.20.4', 3700],
  ['1.20.5', 3837],
  ['1.20.6', 3839],
  ['1.21', 3953],
  ['1.21.1', 3955],
  ['1.21.2', 4080],
  ['1.21.3', 4082],
  ['1.21.4', 4189],
  ['1.21.5', 4325],
  ['1.21.6', 4435],
  ['1.21.7', 4438],
  ['1.21.8', 4440],
  ['1.21.9', 4554],
  ['1.21.10', 4556],
  ['1.21.11', 4671],
];

export const dataVersionOf = (mcVersion: string): number | null => RELEASES.find(([name]) => name === mcVersion)?.[1] ?? null;

export interface VersionGuess {
  version: string;
  // true when the DataVersion lies between two known releases (a snapshot or a patch version missing from the table)
  approximate: boolean;
}

// Release whose DataVersion is the highest one not above `dataVersion`; null below the table (before 1.9)
export function mcVersionFromDataVersion(dataVersion: number): VersionGuess | null {
  let best: (typeof RELEASES)[number] | null = null;
  for (const entry of RELEASES) if (entry[1] <= dataVersion) best = entry;
  if (best === null) return null;
  return { version: best[0], approximate: best[1] !== dataVersion };
}

export type VersionOrder = 'older' | 'same' | 'newer' | 'unknown';

// How the world compares to the Minecraft version it is going to be played on
export function compareWorldToTarget(world: { name: string | null; dataVersion: number | null }, target: string): VersionOrder {
  const targetData = dataVersionOf(target);
  if (world.dataVersion !== null && targetData !== null) {
    return world.dataVersion > targetData ? 'newer' : world.dataVersion < targetData ? 'older' : 'same';
  }
  const worldParts = world.name === null ? null : parseMcVersion(world.name);
  const targetParts = parseMcVersion(target);
  if (worldParts === null || targetParts === null) return 'unknown';
  const diff = compareNumeric(worldParts, targetParts);
  return diff > 0 ? 'newer' : diff < 0 ? 'older' : 'same';
}

// "1.16.5" -> "1.16": the series a version belongs to; years-based versions use the first number
export function seriesOf(version: string): string | null {
  const parts = parseMcVersion(version);
  if (parts === null) return null;
  return parts[0] === 1 ? `1.${parts[1] ?? 0}` : String(parts[0]);
}
