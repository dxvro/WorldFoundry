import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { WorldImportSupport } from '../types.js';
import { msg } from '../../messages.js';
import { findDirs, isFile, moveInto, noWorld } from '../../worldio/game-world.js';
import { ARK_MAPS, parseArkSettings } from './adapter.js';

// what lives in SavedArks: the map save, its backups, players (.arkprofile) and tribes (.arktribe)
const SAVE_FILE = /\.(ark|arkprofile|arktribe|bak|profilebak|tribebak|tmpprofile)$/i;
const MAP_SAVE = /^([A-Za-z0-9_]+)\.ark$/;

export const arkWorldImport: WorldImportSupport = {
  // the SavedArks folder of another server or of single player (ShooterGame/Saved/SavedArks)
  native: async (staged, out, ctx) => {
    const dirs = await findDirs(staged, (_dir, files) => files.some((name) => MAP_SAVE.test(name)));
    // a folder named SavedArks wins over a copy somewhere else in the upload
    const source = dirs.find((dir) => path.basename(dir) === 'SavedArks') ?? dirs[0];
    if (source === undefined) throw noWorld('ARK', 'the SavedArks folder with a <Map>.ark file');
    const target = path.join(out, 'SavedArks');
    for (const name of await readdir(source)) {
      if (SAVE_FILE.test(name) && (await isFile(path.join(source, name)))) await moveInto(path.join(source, name), path.join(target, name));
    }
    const map = parseArkSettings(ctx.server).map;
    const maps = (await readdir(target)).map((name) => MAP_SAVE.exec(name)?.[1]).filter((name): name is string => name !== undefined && !/_\d/.test(name));
    const warnings = maps.includes(map) ? [] : [msg('GAME_IMPORT_ARK_MAP', { found: maps.join(', ') || '?', map: ARK_MAPS[map] ?? map })];
    return { worlds: ['SavedArks'], configItems: [], warnings };
  },
};
