import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client.js';
import { servers } from '../db/schema.js';
import { gameDefinition } from '../games/registry.js';
import { AppError } from './errors.js';

// Parts of the API that still only know Minecraft (server.properties, player lists, the Minecraft world import, mods); exports work for every game. For a server of another game they answer 409 instead of reading or writing files that do not exist there.
const MINECRAFT_ONLY = /^\/api\/servers\/([^/?]+)\/(?:properties|players|world|mods|curseforge)(?:[/?]|$)/;

export function registerMinecraftOnlyGuard(app: FastifyInstance, db: Db): void {
  app.addHook('preHandler', async (request) => {
    const match = MINECRAFT_ONLY.exec(request.url);
    if (match?.[1] === undefined) return;
    let id: string;
    try {
      id = decodeURIComponent(match[1]);
    } catch {
      return;
    }
    const row = (await db.select({ game: servers.game }).from(servers).where(eq(servers.id, id)))[0];
    if (row === undefined || row.game === 'minecraft') return;
    const name = gameDefinition(row.game).name;
    throw new AppError(409, 'GAME_FEATURE_UNSUPPORTED', `This part of WorldFoundry is not available for ${name} servers yet.`, undefined, { game: name });
  });
}
