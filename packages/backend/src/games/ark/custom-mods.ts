import { readdir, readFile, rm, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { findDirs, isDir, isFile } from '../../worldio/game-world.js';
import { folderSize, invalidMod, placeFolder, type CustomMod, type CustomModSupport } from '../custom-mods.js';
import { getSectionValue, setSectionValue } from './ini.js';
import { binaryDir } from './adapter.js';

// A mod of ARK is ShooterGame/Content/Mods/<id>.mod next to the folder <id>/. Uploaded mods carry a marker in their
// folder; they are added to ActiveMods like Workshop mods, but never downloaded by the server.
const contentMods = (dir: string): string => path.join(binaryDir(dir), 'ShooterGame', 'Content', 'Mods');
const MARKER = '.worldfoundry-custom';
const MOD_FILE = /^(\d{1,20})\.mod$/;

async function editActive(file: string, change: (ids: string[]) => string[]): Promise<void> {
  const text = await readFile(file, 'utf8').catch(() => '');
  const current = (getSectionValue(text, 'ServerSettings', 'ActiveMods') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
  const next = [...new Set(change(current))];
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, setSectionValue(text, 'ServerSettings', 'ActiveMods', next.length === 0 ? null : next.join(',')));
}

// ids of the uploaded mods: they stay in ActiveMods when the Workshop list is saved and are never downloaded
export async function customArkIds(dir: string): Promise<string[]> {
  const ids: string[] = [];
  for (const entry of await readdir(contentMods(dir), { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory() && /^\d{1,20}$/.test(entry.name) && (await isFile(path.join(contentMods(dir), entry.name, MARKER)))) ids.push(entry.name);
  }
  return ids;
}

// `settingsFile` is the GameUserSettings.ini of a server folder (the adapter knows the platform folder)
export const arkCustomMods = (settingsFile: (dir: string) => string): CustomModSupport => ({
  accept: '.zip,.tar.gz,.tgz',

  async list(_server, dir) {
    const text = await readFile(settingsFile(dir), 'utf8').catch(() => '');
    const active = new Set((getSectionValue(text, 'ServerSettings', 'ActiveMods') ?? '').split(',').map((id) => id.trim()));
    const mods: CustomMod[] = [];
    for (const id of await customArkIds(dir)) {
      const folder = path.join(contentMods(dir), id);
      mods.push({ id, name: `Mod ${id}`, location: `server/ShooterGame/Content/Mods/${id}`, sizeBytes: await folderSize(folder), active: active.has(id) });
    }
    return mods;
  },

  // <id>.mod with its folder <id>, wherever they sit in the upload (a copy of Content/Mods works as it is)
  async install(_server, dir, staged) {
    const holders = await findDirs(staged, (_folder, files) => files.some((name) => MOD_FILE.test(name)));
    const installed: CustomMod[] = [];
    for (const holder of holders) {
      for (const name of await readdir(holder)) {
        const id = MOD_FILE.exec(name)?.[1];
        if (id === undefined || !(await isDir(path.join(holder, id)))) continue;
        const target = path.join(contentMods(dir), id);
        await placeFolder(path.join(holder, id), target);
        await copyFile(path.join(holder, name), path.join(contentMods(dir), name));
        await writeFile(path.join(target, MARKER), 'Uploaded in WorldFoundry; not downloaded from the Steam Workshop.\n');
        installed.push({ id, name: `Mod ${id}`, location: `server/ShooterGame/Content/Mods/${id}`, sizeBytes: await folderSize(target), active: true });
      }
    }
    if (installed.length === 0) throw invalidMod('ARK', 'the files <id>.mod and the folder <id> from ShooterGame/Content/Mods, packed together as .zip');
    await editActive(settingsFile(dir), (ids) => [...ids, ...installed.map((mod) => mod.id)]);
    return installed;
  },

  async remove(_server, dir, id) {
    await rm(path.join(contentMods(dir), id), { recursive: true, force: true });
    await rm(path.join(contentMods(dir), `${id}.mod`), { force: true });
    await editActive(settingsFile(dir), (ids) => ids.filter((entry) => entry !== id));
  },
});
