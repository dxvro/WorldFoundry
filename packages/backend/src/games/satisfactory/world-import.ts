import path from 'node:path';
import { stat, utimes } from 'node:fs/promises';
import type { WorldImportSupport } from '../types.js';
import { msg } from '../../messages.js';
import { findFiles, moveInto, noWorld } from '../../worldio/game-world.js';

const MAX_SAVES = 200;
// the server's own settings file is a .sav as well, but no save game
const isSaveGame = (name: string): boolean => /\.sav$/i.test(name) && !/^ServerSettings\./i.test(name);

export const satisfactoryWorldImport: WorldImportSupport = {
  // a single .sav straight from the game (%LOCALAPPDATA%/FactoryGame/Saved/SaveGames/<id>/<name>.sav)
  singleFile: (fileName) => isSaveGame(fileName),

  // all save games in the upload, from single player or another server, go into the session folder of this server
  native: async (staged, out) => {
    const saves = await findFiles(staged, isSaveGame, MAX_SAVES + 1);
    if (saves.length === 0) throw noWorld('Satisfactory', 'a save game (.sav), alone or in a .zip');
    if (saves.length > MAX_SAVES) throw noWorld('Satisfactory', `at most ${MAX_SAVES} save games`);
    const used = new Set<string>();
    let newest: { file: string; name: string; mtimeMs: number } | null = null;
    for (const file of saves) {
      let name = path.basename(file);
      // the same name in two folders: the second one is kept under another name
      for (let n = 2; used.has(name.toLowerCase()); n++) name = `${path.basename(file, '.sav')}_${n}.sav`;
      used.add(name.toLowerCase());
      const target = path.join(out, 'server', name);
      const { mtimeMs } = await stat(file);
      await moveInto(file, target);
      if (newest === null || mtimeMs > newest.mtimeMs) newest = { file: target, name, mtimeMs };
    }
    // the server loads the save written last; that stays the newest of the upload, even when the archive lost the times
    if (newest !== null) {
      const now = new Date();
      await utimes(newest.file, now, now);
    }
    return { worlds: ['server'], configItems: [], warnings: [msg('GAME_IMPORT_SATISFACTORY_SAVES', { count: saves.length, newest: newest?.name ?? '' })] };
  },
};
