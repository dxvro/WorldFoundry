import { eq } from 'drizzle-orm';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { servers, type Server } from '../../db/schema.js';
import { AppError } from '../../http/errors.js';
import type { KeyedLock } from '../../lib/keyed-lock.js';
import type { ServerRuntimeGuard } from '../../mods/runtime-guard.js';
import { workshopIdOf, type WorkshopApi, type WorkshopDetails } from '../zomboid/workshop.js';
import { ARK_WORKSHOP_APP, type ArkAdapter } from './adapter.js';
import { setSectionValue } from './ini.js';

export const ArkModsSaveSchema = z.object({ mods: z.array(z.string().regex(/^\d{1,20}$/)).max(200) }).strict();

export interface ArkModsView {
  mods: WorkshopDetails[];
  detailsError: string | null;
}

// Steam Workshop mods of an ARK server: ActiveMods in [ServerSettings] of GameUserSettings.ini, in load order.
// The server downloads them itself with -automanagedmods.
export class ArkModsService {
  constructor(private readonly options: { db: Db; serversDir: string; lock: KeyedLock; guard: ServerRuntimeGuard; api: WorkshopApi; adapter: ArkAdapter }) {}

  private async server(serverId: string): Promise<Server> {
    const row = (await this.options.db.select().from(servers).where(eq(servers.id, serverId)))[0];
    if (row === undefined) throw new AppError(404, 'SERVER_NOT_FOUND', 'The server was not found.');
    if (row.game !== 'ark') throw new AppError(409, 'GAME_FEATURE_UNSUPPORTED', 'These mods are only available for ARK servers.', undefined, { game: row.game });
    return row;
  }

  async get(serverId: string): Promise<ArkModsView> {
    const server = await this.server(serverId);
    const ids = await this.options.adapter.activeMods(path.join(this.options.serversDir, server.id));
    try {
      return { mods: await this.options.api.details(ids), detailsError: null };
    } catch (error) {
      return {
        mods: ids.map((id) => ({ id, found: false, title: null, previewUrl: null, sizeBytes: null, updatedAt: null, modIds: [], mapFolders: [], forZomboid: false, appId: null })),
        detailsError: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async lookup(input: string): Promise<WorkshopDetails> {
    const id = workshopIdOf(input);
    if (id === null) throw new AppError(422, 'WORKSHOP_ID_INVALID', 'Please enter a Workshop id or the link of a Workshop item.');
    const [details] = await this.options.api.details([id]);
    if (details === undefined || !details.found) throw new AppError(404, 'WORKSHOP_NOT_FOUND', 'This Workshop item was not found or is not public.');
    if (details.appId !== null && details.appId !== ARK_WORKSHOP_APP) throw new AppError(422, 'WORKSHOP_WRONG_GAME', 'This Workshop item is not for ARK: Survival Evolved.');
    return details;
  }

  async save(serverId: string, mods: string[]): Promise<ArkModsView> {
    const running = (): AppError => new AppError(409, 'SERVER_RUNNING', 'The server is running. Please stop it before changing its mods.');
    if (this.options.guard.isRunning(serverId)) throw running();
    await this.options.lock.run(serverId, async () => {
      if (this.options.guard.isRunning(serverId)) throw running();
      const server = await this.server(serverId);
      const file = this.options.adapter.gameUserSettings(path.join(this.options.serversDir, server.id));
      const unique = [...new Set(mods)];
      const text = setSectionValue(await readFile(file, 'utf8').catch(() => ''), 'ServerSettings', 'ActiveMods', unique.length === 0 ? null : unique.join(','));
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(`${file}.part`, text, 'utf8');
      await rename(`${file}.part`, file);
    });
    return this.get(serverId);
  }
}
