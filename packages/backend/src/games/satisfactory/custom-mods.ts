import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../../http/errors.js';
import { findDirs, isFile } from '../../worldio/game-world.js';
import { folderSize, invalidMod, placeFolder, safeFolderName, type CustomMod, type CustomModSupport } from '../custom-mods.js';
import { binaryDir } from './adapter.js';

// Mods are Unreal plugins: FactoryGame/Mods/<Name>/<Name>.uplugin. ficsit.app installs keep their list in
// .worldfoundry-mods.json; an uploaded mod carries a marker file instead.
const modsDir = (dir: string): string => path.join(binaryDir(dir), 'FactoryGame', 'Mods');
const MARKER = '.worldfoundry-custom';
const FICSIT_MANIFEST = '.worldfoundry-mods.json';

async function ficsitNames(dir: string): Promise<Set<string>> {
  try {
    const parsed = JSON.parse(await readFile(path.join(modsDir(dir), FICSIT_MANIFEST), 'utf8')) as { mods?: Array<{ reference?: string }> };
    return new Set((parsed.mods ?? []).map((mod) => mod.reference ?? '').filter((name) => name !== ''));
  } catch {
    return new Set();
  }
}

async function friendlyName(file: string, fallback: string): Promise<string> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { FriendlyName?: unknown };
    return typeof parsed.FriendlyName === 'string' && parsed.FriendlyName.trim() !== '' ? parsed.FriendlyName.trim() : fallback;
  } catch {
    return fallback;
  }
}

export const satisfactoryCustomMods: CustomModSupport = {
  accept: '.zip,.tar.gz,.tgz',

  async list(_server, dir) {
    const mods: CustomMod[] = [];
    for (const entry of await readdir(modsDir(dir), { withFileTypes: true }).catch(() => [])) {
      const folder = path.join(modsDir(dir), entry.name);
      if (!entry.isDirectory() || !(await isFile(path.join(folder, MARKER)))) continue;
      const name = await friendlyName(path.join(folder, `${entry.name}.uplugin`), entry.name);
      mods.push({ id: entry.name, name, location: `server/FactoryGame/Mods/${entry.name}`, sizeBytes: await folderSize(folder), active: null });
    }
    return mods.sort((a, b) => a.name.localeCompare(b.name));
  },

  // every folder in the upload that holds a <Name>.uplugin; the folder gets the plugin's name, as the game expects
  async install(_server, dir, staged) {
    const roots = await findDirs(staged, (_folder, files) => files.some((name) => name.toLowerCase().endsWith('.uplugin')));
    const managed = await ficsitNames(dir);
    const installed: CustomMod[] = [];
    for (const root of roots) {
      const plugin = (await readdir(root)).find((name) => name.toLowerCase().endsWith('.uplugin'));
      if (plugin === undefined) continue;
      const name = safeFolderName(plugin.slice(0, -'.uplugin'.length), 'mod name');
      if (managed.has(name)) {
        throw new AppError(409, 'MOD_ALREADY_INSTALLED', `The mod "${name}" is installed from ficsit.app. Remove it there first to use your own version.`, undefined, { name });
      }
      const target = path.join(modsDir(dir), name);
      await placeFolder(root, target);
      await writeFile(path.join(target, MARKER), 'Uploaded in WorldFoundry; not managed by ficsit.app.\n');
      installed.push({ id: name, name: await friendlyName(path.join(target, plugin), name), location: `server/FactoryGame/Mods/${name}`, sizeBytes: await folderSize(target), active: null });
    }
    if (installed.length === 0) throw invalidMod('Satisfactory', 'a mod folder with a <Name>.uplugin file, packed as .zip (the server build of the mod)');
    return installed;
  },

  async remove(_server, dir, id) {
    await rm(path.join(modsDir(dir), id), { recursive: true, force: true });
  },
};
