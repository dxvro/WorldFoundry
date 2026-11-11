import { readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Server } from '../../db/schema.js';
import { findDirs, isDir } from '../../worldio/game-world.js';
import { folderSize, invalidMod, placeFolder, safeFolderName, type CustomMod, type CustomModSupport } from '../custom-mods.js';
import { dataDir, iniFile, parseZomboidSettings } from './adapter.js';
import { readIniValues, setIniValues } from './ini.js';

// Local mods of a server: <cachedir>/mods/<folder>, each with a mod.info. Build 42 puts mod.info into a version
// folder (<folder>/42/mod.info, next to <folder>/common); Build 41 has it in the mod folder itself.
const modsDir = (dir: string): string => path.join(dataDir(dir), 'mods');
const VERSION_FOLDER = /^\d+(?:\.\d+)*$/;

function parseModInfo(text: string): { id: string | null; name: string | null } {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index > 0) values.set(line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim());
  }
  const id = values.get('id') ?? null;
  return { id: id === null || id === '' ? null : id, name: values.get('name') ?? null };
}

// the mod.info of a mod folder: in the folder itself or in its newest version folder
async function modInfoOf(folder: string): Promise<{ id: string; name: string } | null> {
  const candidates = [path.join(folder, 'mod.info')];
  const versions = (await readdir(folder, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory() && VERSION_FOLDER.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const version of versions) candidates.push(path.join(folder, version, 'mod.info'));
  for (const file of candidates) {
    const text = await readFile(file, 'utf8').catch(() => null);
    if (text === null) continue;
    const info = parseModInfo(text);
    if (info.id !== null) return { id: info.id, name: info.name ?? info.id };
  }
  return null;
}

const split = (value: string | undefined): string[] =>
  (value ?? '')
    .split(';')
    .map((item) => item.trim())
    .filter((item) => item !== '');

async function editMods(server: Server, dir: string, change: (mods: string[]) => string[]): Promise<void> {
  const file = iniFile(dir, parseZomboidSettings(server).profile);
  const text = await readFile(file, 'utf8').catch(() => '');
  const next = change(split(readIniValues(text).get('Mods')));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, setIniValues(text, { Mods: [...new Set(next)].join(';') }));
}

// the mod ids of the local mods, so the Workshop list does not drop them from Mods=
export async function localModIds(dir: string): Promise<string[]> {
  const ids: string[] = [];
  for (const entry of await readdir(modsDir(dir), { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const info = await modInfoOf(path.join(modsDir(dir), entry.name));
    if (info !== null) ids.push(info.id);
  }
  return ids;
}

export const zomboidCustomMods: CustomModSupport = {
  accept: '.zip,.tar.gz,.tgz',

  async list(server, dir) {
    const active = new Set(split(readIniValues(await readFile(iniFile(dir, parseZomboidSettings(server).profile), 'utf8').catch(() => '')).get('Mods')));
    const mods: CustomMod[] = [];
    for (const entry of await readdir(modsDir(dir), { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      const folder = path.join(modsDir(dir), entry.name);
      const info = await modInfoOf(folder);
      if (info === null) continue;
      mods.push({ id: info.id, name: info.name, location: `data/mods/${entry.name}`, sizeBytes: await folderSize(folder), active: active.has(info.id) });
    }
    return mods.sort((a, b) => a.name.localeCompare(b.name));
  },

  // every mod folder in the upload (a zip of one mod, of several, or a Workshop item with mods/<name>)
  async install(server, dir, staged) {
    const found = await findDirs(staged, (_folder, files) => files.includes('mod.info'));
    const roots = new Set<string>();
    for (const folder of found) roots.add(VERSION_FOLDER.test(path.basename(folder)) || path.basename(folder) === 'common' ? path.dirname(folder) : folder);
    const installed: CustomMod[] = [];
    for (const root of roots) {
      const info = await modInfoOf(root);
      if (info === null) continue;
      const folderName = safeFolderName(root === staged ? info.id : path.basename(root), 'mod folder');
      const target = path.join(modsDir(dir), folderName);
      await placeFolder(root, target);
      installed.push({ id: info.id, name: info.name, location: `data/mods/${folderName}`, sizeBytes: await folderSize(target), active: true });
    }
    if (installed.length === 0) throw invalidMod('Project Zomboid', 'a mod folder with a mod.info file (Build 41) or with 42/mod.info (Build 42), packed as .zip');
    await editMods(server, dir, (mods) => [...mods, ...installed.map((mod) => mod.id)]);
    return installed;
  },

  async remove(server, dir, id) {
    for (const entry of await readdir(modsDir(dir), { withFileTypes: true }).catch(() => [])) {
      const folder = path.join(modsDir(dir), entry.name);
      if (entry.isDirectory() && (await modInfoOf(folder))?.id === id && (await isDir(folder))) await rm(folder, { recursive: true, force: true });
    }
    await editMods(server, dir, (mods) => mods.filter((mod) => mod !== id));
  },
};
