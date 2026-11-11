import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { findDirs, isFile } from '../../worldio/game-world.js';
import { folderSize, invalidMod, placeFolder, safeFolderName } from '../custom-mods.js';
import type { CustomMod, CustomModSupport } from '../types.js';

// Server mods live in Mods/<Name>/ModInfo.xml next to the server program; an uploaded one carries a marker file
const modsDir = (dir: string): string => path.join(dir, 'server', 'Mods');
const MARKER = '.worldfoundry-custom';

// ModInfo.xml (V2): <Name value="..."/> and <DisplayName value="..."/>; V1 wraps them in <ModInfo>
async function modName(folder: string, fallback: string): Promise<{ name: string; display: string }> {
  const file = (await readdir(folder)).find((entry) => entry.toLowerCase() === 'modinfo.xml');
  const text = file === undefined ? '' : await readFile(path.join(folder, file), 'utf8').catch(() => '');
  const value = (tag: string): string | undefined => new RegExp(`<${tag}\\s+value="([^"]{1,80})"`, 'i').exec(text)?.[1];
  return { name: value('Name') ?? fallback, display: value('DisplayName') ?? value('Name') ?? fallback };
}

export const sevenDaysCustomMods: CustomModSupport = {
  accept: '.zip,.tar.gz,.tgz',

  async list(_server, dir) {
    const mods: CustomMod[] = [];
    for (const entry of await readdir(modsDir(dir), { withFileTypes: true }).catch(() => [])) {
      const folder = path.join(modsDir(dir), entry.name);
      if (!entry.isDirectory() || !(await isFile(path.join(folder, MARKER)))) continue;
      mods.push({ id: entry.name, name: (await modName(folder, entry.name)).display, location: `server/Mods/${entry.name}`, sizeBytes: await folderSize(folder), active: null });
    }
    return mods.sort((a, b) => a.name.localeCompare(b.name));
  },

  // every folder with a ModInfo.xml; it keeps its folder name, or takes the mod's name when the zip had no folder
  async install(_server, dir, staged) {
    const roots = await findDirs(staged, (_folder, files) => files.some((name) => name.toLowerCase() === 'modinfo.xml'));
    const installed: CustomMod[] = [];
    for (const root of roots) {
      const info = await modName(root, path.basename(root));
      const folderName = safeFolderName(root === staged ? info.name : path.basename(root), 'mod folder');
      const target = path.join(modsDir(dir), folderName);
      await placeFolder(root, target);
      await writeFile(path.join(target, MARKER), 'Uploaded in WorldFoundry.\n');
      installed.push({ id: folderName, name: info.display, location: `server/Mods/${folderName}`, sizeBytes: await folderSize(target), active: null });
    }
    if (installed.length === 0) throw invalidMod('7 Days to Die', 'a mod folder with a ModInfo.xml, packed as .zip');
    return installed;
  },

  async remove(_server, dir, id) {
    await rm(path.join(modsDir(dir), id), { recursive: true, force: true });
  },
};
