import { cp, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { WorldImportSupport } from '../types.js';
import { msg } from '../../messages.js';
import { findDirs, isDir, isFile, moveInto, noWorld } from '../../worldio/game-world.js';
import { readIniValues, setIniValues } from './ini.js';
import { iniFile, parseZomboidSettings } from './adapter.js';

// Files in Server/ that carry the profile in their name
const PROFILE_FILES = ['.ini', '_SandboxVars.lua', '_spawnregions.lua', '_spawnpoints.lua'];
// a save folder of Project Zomboid (single player or server) holds its map files next to map_ver.bin
const isSave = (files: string[]): boolean => files.includes('map_ver.bin');

// Renames everything that carries the old profile name to the profile of this server
async function renameProfile(out: string, from: string, to: string): Promise<void> {
  if (from === to) return;
  const save = path.join(out, 'Saves', 'Multiplayer');
  if (await isDir(path.join(save, from))) await rename(path.join(save, from), path.join(save, to));
  const db = path.join(out, 'db');
  if (await isFile(path.join(db, `${from}.db`))) await rename(path.join(db, `${from}.db`), path.join(db, `${to}.db`));
  const server = path.join(out, 'Server');
  for (const suffix of PROFILE_FILES) {
    if (await isFile(path.join(server, `${from}${suffix}`))) await rename(path.join(server, `${from}${suffix}`), path.join(server, `${to}${suffix}`));
  }
}

export const zomboidWorldImport: WorldImportSupport = {
  adopt: async (out, sourceLevel, ctx) => renameProfile(out, sourceLevel, ctx.layout.levelName),

  // A save folder (map_ver.bin) from a server or from single player. The settings of this server stay; the player
  // database of the source comes along when it sits next to the save (Zomboid/db/<name>.db).
  native: async (staged, out, ctx) => {
    const saves = await findDirs(staged, (_dir, files) => isSave(files));
    const save = saves[0];
    if (save === undefined) throw noWorld('Project Zomboid', 'a save folder with map_ver.bin (Zomboid/Saves/Multiplayer/<name> or Zomboid/Saves/Sandbox/<name>)');
    const profile = ctx.layout.levelName;
    const name = path.basename(save);
    const warnings = saves.length > 1 ? [msg('GAME_IMPORT_FIRST_OF_SEVERAL', { count: saves.length, name })] : [];
    // the Zomboid folder: two levels above Saves/<mode>/<name>
    const zomboidRoot = path.dirname(path.dirname(path.dirname(save)));
    const fromSaves = path.basename(path.dirname(path.dirname(save))) === 'Saves';
    await moveInto(save, path.join(out, 'Saves', 'Multiplayer', profile));
    const worlds = ['Saves'];
    const sourceDb = path.join(zomboidRoot, 'db', `${name}.db`);
    if (fromSaves && (await isFile(sourceDb))) {
      await moveInto(sourceDb, path.join(out, 'db', `${profile}.db`));
      worlds.push('db');
    }
    // Server/ and db/ are replaced as a whole on restore: what the upload does not bring is kept from this server
    for (const keep of ['Server', 'db']) {
      if (worlds.includes(keep)) continue;
      const current = path.join(ctx.layout.root, keep);
      if (await isDir(current)) {
        await cp(current, path.join(out, keep), { recursive: true });
        worlds.push(keep);
      }
    }
    warnings.push(msg('GAME_IMPORT_ZOMBOID_SETTINGS_KEPT'));
    return { worlds, configItems: [], warnings };
  },

  // an imported Server/<profile>.ini may name the ports of another server: the ports of this server win
  after: async (ctx) => {
    const settings = parseZomboidSettings(ctx.server);
    const file = iniFile(ctx.dir, settings.profile);
    const current = await readFile(file, 'utf8').catch(() => null);
    if (current === null) return [];
    const values = readIniValues(current);
    if (values.get('DefaultPort')?.trim() === String(ctx.server.port) && values.get('UDPPort')?.trim() === String(settings.udpPort)) return [];
    await writeFile(file, setIniValues(current, { DefaultPort: String(ctx.server.port), UDPPort: String(settings.udpPort) }));
    return [msg('GAME_IMPORT_PORTS_KEPT')];
  },
};

