import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { TarSource } from '../archive/tar.js';
import { AppError } from '../http/errors.js';
import { loadProperties } from '../properties/store.js';

export const MANIFEST_NAME = 'worldfoundry-backup.json';
export const DEFAULT_LEVEL = 'world';
// Held open and locked by a running server (Windows refuses to read it); the server recreates it at start
const EXCLUDED_NAMES: ReadonlySet<string> = new Set(['session.lock']);
const MAX_DEPTH = 64;

// What "configuration" means for a backup: the files an admin edits, not the (large) data of plugins
export const CONFIG_FILES: readonly string[] = [
  'server.properties',
  'ops.json',
  'whitelist.json',
  'banned-players.json',
  'banned-ips.json',
  'bukkit.yml',
  'spigot.yml',
  'paper.yml',
  'commands.yml',
  'permissions.yml',
  'help.yml',
];
export const CONFIG_DIRS: readonly string[] = ['config', 'defaultconfigs'];

// Vanilla keeps the dimensions of a world below its folder (DIM-1, DIM1); Bukkit-based servers (Paper) put
// the Nether and the End next to it as <level>_nether and <level>_the_end
export const worldNames = (level: string): string[] => [level, `${level}_nether`, `${level}_the_end`];

// Folders the server, the loader or the mods own: a world with one of these names would clash with them
// (and a backup or import would treat their content as a world)
const SERVER_OWNED_NAMES: ReadonlySet<string> = new Set([
  'mods',
  'plugins',
  'config',
  'libraries',
  'logs',
  'crash-reports',
  'versions',
  'cache',
  'defaultconfigs',
  '.fabric',
  '.mixin.out',
]);
// reserved device names on Windows, with or without an extension ("nul", "CON.txt", "com1 .x")
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9]) *(\..*)?$/i;

// a single folder name next to server.jar: no separators, no drive letters, no "." or ".." and no trailing dot or blank;
// not hidden (leading dot), not a folder the server owns and not a Windows device name
export function isValidLevelName(raw: string): boolean {
  const name = raw.trim();
  if (name === '' || name.length > 100 || name.startsWith('.') || /[\\/:*?"<>|\u0000-\u001f]/.test(name) || /[ .]$/.test(name)) return false;
  return !SERVER_OWNED_NAMES.has(name.toLowerCase()) && !WINDOWS_DEVICE.test(name);
}

export function validateLevelName(raw: string): string {
  if (!isValidLevelName(raw)) {
    throw new AppError(422, 'BACKUP_LEVEL_INVALID', `The world name "${raw.slice(0, 60)}" in server.properties (level-name) is invalid and cannot be backed up.`, undefined, { levelName: raw.slice(0, 60) });
  }
  return raw.trim();
}

export async function readLevelName(serverDir: string): Promise<string> {
  const { doc } = await loadProperties(serverDir);
  const raw = doc.get('level-name');
  return validateLevelName(raw === undefined || raw.trim() === '' ? DEFAULT_LEVEL : raw);
}

export interface Collected {
  sources: TarSource[];
  fileCount: number;
  rawBytes: number;
  worlds: string[];
  configItems: string[];
  skipped: string[];
}

async function walk(abs: string, rel: string, out: Collected, depth: number): Promise<void> {
  if (depth > MAX_DEPTH) throw new AppError(422, 'BACKUP_TOO_DEEP', `The folder structure under "${rel}" is nested too deeply.`, undefined, { path: rel });
  const info = await lstat(abs);
  out.sources.push({ kind: 'dir', name: rel, mtimeMs: info.mtimeMs, mode: 0o755 });
  const entries = (await readdir(abs, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (EXCLUDED_NAMES.has(entry.name)) continue;
    const childRel = `${rel}/${entry.name}`;
    const childAbs = path.join(abs, entry.name);
    if (entry.isSymbolicLink()) {
      out.skipped.push(childRel);
    } else if (entry.isDirectory()) {
      await walk(childAbs, childRel, out, depth + 1);
    } else if (entry.isFile()) {
      const stats = await lstat(childAbs);
      out.sources.push({ kind: 'file', name: childRel, file: childAbs, size: stats.size, mtimeMs: stats.mtimeMs, mode: 0o644 });
      out.fileCount++;
      out.rawBytes += stats.size;
    }
  }
}

const exists = (file: string): Promise<'file' | 'dir' | null> =>
  lstat(file).then(
    (info) => (info.isDirectory() ? 'dir' : info.isFile() ? 'file' : null),
    () => null,
  );

// What a backup of one server contains, relative to `root`: the world folders (always) and the configuration
// (when asked). Minecraft reads its world name from server.properties; other games name fixed folders.
export interface BackupLayout {
  root: string;
  levelName: string;
  worlds: (level: string) => string[];
  configFiles: readonly string[];
  configDirs: readonly string[];
  // false: the game has no safe "pause saving", so a backup needs the server stopped
  live: boolean;
  validateLevel: (level: string) => string;
}

export async function minecraftLayout(serverDir: string): Promise<BackupLayout> {
  return { root: serverDir, levelName: await readLevelName(serverDir), worlds: worldNames, configFiles: CONFIG_FILES, configDirs: CONFIG_DIRS, live: true, validateLevel: validateLevelName };
}

export async function collectSources(serverDir: string, level: string, includeConfig: boolean): Promise<Collected> {
  return collectLayout({ root: serverDir, worlds: worldNames, configFiles: CONFIG_FILES, configDirs: CONFIG_DIRS }, level, includeConfig);
}

export async function collectLayout(
  layout: Pick<BackupLayout, 'root' | 'worlds' | 'configFiles' | 'configDirs'>,
  level: string,
  includeConfig: boolean,
): Promise<Collected> {
  const serverDir = layout.root;
  const CONFIG_FILES = layout.configFiles;
  const CONFIG_DIRS = layout.configDirs;
  const out: Collected = { sources: [], fileCount: 0, rawBytes: 0, worlds: [], configItems: [], skipped: [] };
  for (const name of layout.worlds(level)) {
    if ((await exists(path.join(serverDir, name))) !== 'dir') continue;
    out.worlds.push(name);
    await walk(path.join(serverDir, name), name, out, 0);
  }
  if (includeConfig) {
    for (const name of CONFIG_FILES) {
      const abs = path.join(serverDir, name);
      if ((await exists(abs)) !== 'file') continue;
      const stats = await lstat(abs);
      out.sources.push({ kind: 'file', name, file: abs, size: stats.size, mtimeMs: stats.mtimeMs, mode: 0o644 });
      out.configItems.push(name);
      out.fileCount++;
      out.rawBytes += stats.size;
    }
    for (const name of CONFIG_DIRS) {
      if ((await exists(path.join(serverDir, name))) !== 'dir') continue;
      out.configItems.push(name);
      await walk(path.join(serverDir, name), name, out, 0);
    }
  }
  return out;
}

// cheap check before a backup is queued: is there anything the backup would contain
export async function hasAnyData(serverDir: string, level: string, includeConfig: boolean): Promise<boolean> {
  return hasLayoutData({ root: serverDir, worlds: worldNames, configFiles: CONFIG_FILES, configDirs: CONFIG_DIRS }, level, includeConfig);
}

export async function hasLayoutData(layout: Pick<BackupLayout, 'root' | 'worlds' | 'configFiles' | 'configDirs'>, level: string, includeConfig: boolean): Promise<boolean> {
  const serverDir = layout.root;
  const CONFIG_FILES = layout.configFiles;
  const CONFIG_DIRS = layout.configDirs;
  for (const name of layout.worlds(level)) if ((await exists(path.join(serverDir, name))) === 'dir') return true;
  if (!includeConfig) return false;
  for (const name of CONFIG_FILES) if ((await exists(path.join(serverDir, name))) === 'file') return true;
  for (const name of CONFIG_DIRS) if ((await exists(path.join(serverDir, name))) === 'dir') return true;
  return false;
}

// newest modification time below the world folders, for skipping a scheduled backup of an unchanged, stopped server
export async function newestChange(serverDir: string, level: string, worlds: (level: string) => string[] = worldNames): Promise<number> {
  let newest = 0;
  const visit = async (abs: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) return;
    const info = await lstat(abs).catch(() => null);
    if (info === null) return;
    newest = Math.max(newest, info.mtimeMs);
    if (!info.isDirectory()) return;
    for (const entry of await readdir(abs).catch(() => [])) if (!EXCLUDED_NAMES.has(entry)) await visit(path.join(abs, entry), depth + 1);
  };
  for (const name of worlds(level)) await visit(path.join(serverDir, name), 0);
  return newest;
}
