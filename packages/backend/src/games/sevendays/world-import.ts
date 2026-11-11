import { cp } from 'node:fs/promises';
import path from 'node:path';
import { msg } from '../../messages.js';
import { findDirs, isDir, isFile, moveInto, noWorld } from '../../worldio/game-world.js';
import type { WorldImportSupport } from '../types.js';
import { parseSevenDaysSettings } from './adapter.js';

// A game save is Saves/<world>/<game name>/ with main.ttw; a random world also needs GeneratedWorlds/<world>.
export const sevenDaysWorldImport: WorldImportSupport = {
  native: async (staged, out, ctx) => {
    const saves = await findDirs(staged, (_dir, files) => files.includes('main.ttw'));
    const save = saves[0];
    if (save === undefined) throw noWorld('7 Days to Die', 'a save folder with main.ttw (Saves/<world>/<game name>)');
    const game = path.basename(save);
    const world = path.basename(path.dirname(save));
    await moveInto(save, path.join(out, 'Saves', world, game));
    const warnings = saves.length > 1 ? [msg('GAME_IMPORT_FIRST_OF_SEVERAL', { count: saves.length, name: `${world}/${game}` })] : [];
    // the generated world of a random map, wherever it sits in the upload
    const generated = (await findDirs(staged, (dir) => path.basename(path.dirname(dir)) === 'GeneratedWorlds' && path.basename(dir) === world))[0];
    const worlds = ['Saves'];
    if (generated !== undefined) {
      await moveInto(generated, path.join(out, 'GeneratedWorlds', world));
      worlds.push('GeneratedWorlds');
    }
    // the admin list of the upload, else the one of this server; Saves and GeneratedWorlds are replaced as a whole
    const uploadedAdmin = (await findDirs(staged, (_dir, files) => files.includes('serveradmin.xml')))[0];
    const currentAdmin = path.join(ctx.layout.root, 'Saves', 'serveradmin.xml');
    if (uploadedAdmin !== undefined) await moveInto(path.join(uploadedAdmin, 'serveradmin.xml'), path.join(out, 'Saves', 'serveradmin.xml'));
    else if (await isFile(currentAdmin)) await cp(currentAdmin, path.join(out, 'Saves', 'serveradmin.xml'));
    if (!worlds.includes('GeneratedWorlds') && (await isDir(path.join(ctx.layout.root, 'GeneratedWorlds')))) {
      await cp(path.join(ctx.layout.root, 'GeneratedWorlds'), path.join(out, 'GeneratedWorlds'), { recursive: true });
      worlds.push('GeneratedWorlds');
    }
    const settings = parseSevenDaysSettings(ctx.server);
    if (settings.world !== world || settings.gameName !== game) warnings.push(msg('GAME_IMPORT_WORLD_NAME', { found: `${world} / ${game}`, current: `${settings.world} / ${settings.gameName}` }));
    return { worlds, configItems: [], warnings };
  },
};
