import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ArkModsSaveSchema, type ArkModsService } from '../../games/ark/mods.js';

const serverParams = z.object({ serverId: z.string().min(1).max(100) });
const lookupQuery = z.object({ q: z.string().min(1).max(500) });

export function registerArkModRoutes(app: FastifyInstance, mods: ArkModsService): void {
  app.get('/api/ark/workshop/lookup', async (request) => ({ item: await mods.lookup(lookupQuery.parse(request.query).q) }));
  app.get('/api/servers/:serverId/ark-mods', async (request) => mods.get(serverParams.parse(request.params).serverId));
  app.put('/api/servers/:serverId/ark-mods', async (request) => mods.save(serverParams.parse(request.params).serverId, ArkModsSaveSchema.parse(request.body).mods));
}
