import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../http/errors.js';
import type { LaunchSpec } from './launch-spec.js';

const ARGS_ROOTS: Record<'forge' | 'neoforge', string> = {
  forge: 'libraries/net/minecraftforge/forge',
  neoforge: 'libraries/net/neoforged/neoforge',
};

const isFile = (file: string): Promise<boolean> =>
  stat(file).then(
    (info) => info.isFile(),
    () => false,
  );

async function listDirectories(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function listJars(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /\.jar$/i.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

const missing = (): AppError =>
  new AppError(
    500,
    'LAUNCH_TARGET_NOT_FOUND',
    'No startable file was found after the installation. Details are in the install.log file in the server folder.',
  );

// Modern Forge/NeoForge write unix_args.txt + win_args.txt below libraries/; legacy Forge leaves a forge-*.jar.
export async function detectForgeLaunch(
  serverDir: string,
  loader: 'forge' | 'neoforge',
  mcVersion: string,
  loaderVersion: string | null,
): Promise<LaunchSpec> {
  const root = ARGS_ROOTS[loader];
  const withArgs: string[] = [];
  for (const name of (await listDirectories(path.join(serverDir, root))).sort()) {
    const dir = path.join(serverDir, root, name);
    if ((await isFile(path.join(dir, 'unix_args.txt'))) && (await isFile(path.join(dir, 'win_args.txt')))) withArgs.push(name);
  }
  if (withArgs.length > 0) {
    const chosen = withArgs.find((name) => loaderVersion !== null && name.endsWith(loaderVersion)) ?? withArgs.at(-1);
    if (chosen !== undefined) {
      return { kind: 'args', unixFile: `${root}/${chosen}/unix_args.txt`, winFile: `${root}/${chosen}/win_args.txt` };
    }
  }

  if (loader === 'forge') {
    const jars = (await listJars(serverDir)).filter((name) => /^forge-/i.test(name) && !/installer|sources|shim|javadoc/i.test(name));
    const exact = loaderVersion === null ? undefined : jars.find((name) => name === `forge-${mcVersion}-${loaderVersion}.jar`);
    const universal = jars.filter((name) => /-universal\.jar$/i.test(name));
    const chosen = exact ?? (universal.length === 1 ? universal[0] : undefined) ?? (jars.length === 1 ? jars[0] : undefined);
    if (chosen !== undefined) return { kind: 'jar', jar: chosen };
  }
  throw missing();
}
