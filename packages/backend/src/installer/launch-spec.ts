import { z } from 'zod';

export const LaunchSpecSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('jar'), jar: z.string().min(1) }),
  z.object({ kind: z.literal('args'), unixFile: z.string().min(1), winFile: z.string().min(1) }),
]);

export type LaunchSpec = z.infer<typeof LaunchSpecSchema>;

export function parseLaunchSpec(raw: string | null): LaunchSpec | null {
  if (raw === null) return null;
  try {
    const parsed = LaunchSpecSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export const serializeLaunchSpec = (spec: LaunchSpec): string => JSON.stringify(spec);

// relative path of the file the JVM is pointed at, picked for the given platform
export function launchTarget(spec: LaunchSpec, platform: NodeJS.Platform): { argument: string[]; file: string } {
  if (spec.kind === 'jar') return { argument: ['-jar', spec.jar], file: spec.jar };
  const file = platform === 'win32' ? spec.winFile : spec.unixFile;
  return { argument: [`@${file}`], file };
}
