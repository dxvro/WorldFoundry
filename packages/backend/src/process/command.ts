import { launchTarget, type LaunchSpec } from '../installer/launch-spec.js';
import { tokenizeArgs } from './tokenize.js';

export const LARGE_HEAP_THRESHOLD_MB = 12 * 1024;

// A newer JDK refuses to start over a VM option it removed; with the Aikar set enabled it is told to skip those.
// Without Aikar the flag stays out so a typo in user-supplied arguments still fails visibly.
export const IGNORE_UNRECOGNIZED_VM_OPTIONS = '-XX:+IgnoreUnrecognizedVMOptions';

// Aikar's flags; heaps of 12 GB and more use the larger region/young-generation values
export function aikarFlags(maxRamMb: number): string[] {
  const large = maxRamMb >= LARGE_HEAP_THRESHOLD_MB;
  return [
    '-XX:+UseG1GC',
    '-XX:+ParallelRefProcEnabled',
    '-XX:MaxGCPauseMillis=200',
    '-XX:+UnlockExperimentalVMOptions',
    '-XX:+DisableExplicitGC',
    '-XX:+AlwaysPreTouch',
    `-XX:G1NewSizePercent=${large ? 40 : 30}`,
    `-XX:G1MaxNewSizePercent=${large ? 50 : 40}`,
    `-XX:G1HeapRegionSize=${large ? 16 : 8}M`,
    `-XX:G1ReservePercent=${large ? 15 : 20}`,
    '-XX:G1HeapWastePercent=5',
    '-XX:G1MixedGCCountTarget=4',
    `-XX:InitiatingHeapOccupancyPercent=${large ? 20 : 15}`,
    '-XX:G1MixedGCLiveThresholdPercent=90',
    '-XX:G1RSetUpdatingPauseTimePercent=5',
    '-XX:SurvivorRatio=32',
    '-XX:+PerfDisableSharedMem',
    '-XX:MaxTenuringThreshold=1',
    '-Dusing.aikars.flags=https://mcflags.emc.gs',
    '-Daikars.new.flags=true',
  ];
}

export interface CommandInput {
  minRamMb: number;
  maxRamMb: number;
  useAikarFlags: boolean;
  extraJvmArgs: string;
  launch: LaunchSpec;
  platform: NodeJS.Platform;
}

export function buildJavaArgs(input: CommandInput): string[] {
  return [
    `-Xms${input.minRamMb}M`,
    `-Xmx${input.maxRamMb}M`,
    ...(input.useAikarFlags ? [IGNORE_UNRECOGNIZED_VM_OPTIONS, ...aikarFlags(input.maxRamMb)] : []),
    ...tokenizeArgs(input.extraJvmArgs),
    '-Dfile.encoding=UTF-8',
    '-Dstdout.encoding=UTF-8',
    '-Dstderr.encoding=UTF-8',
    ...launchTarget(input.launch, input.platform).argument,
    'nogui',
  ];
}
