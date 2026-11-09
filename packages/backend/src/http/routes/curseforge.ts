import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CurseForgeService } from '../../curseforge/service.js';
import type { ModService } from '../../mods/service.js';

const serverParams = z.object({ serverId: z.string().min(1) });
const keyBody = z.object({ apiKey: z.string().max(300) }).strict();
const searchQuery = z.object({
  query: z.string().max(100).default(''),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});
const installBody = z.object({ modId: z.number().int().positive(), fileId: z.number().int().positive().optional() }).strict();

// The key is write-only: the API says whether one is set, never what it is.
export function registerCurseForgeRoutes(app: FastifyInstance, curseforge: CurseForgeService, mods: ModService): void {
  app.get('/api/system/curseforge', async () => curseforge.status());

  app.put('/api/system/curseforge', async (request) => curseforge.setKey(keyBody.parse(request.body).apiKey));

  app.delete('/api/system/curseforge', async () => curseforge.clearKey());

  app.get('/api/servers/:serverId/curseforge/search', async (request) => {
    const { serverId } = serverParams.parse(request.params);
    const { query, offset } = searchQuery.parse(request.query);
    return curseforge.search(serverId, query, offset);
  });

  app.post('/api/servers/:serverId/curseforge/install', async (request, reply) => {
    const { serverId } = serverParams.parse(request.params);
    const body = installBody.parse(request.body);
    const result = await mods.installFromCurseForge(serverId, curseforge.api, await curseforge.key(), body.modId, body.fileId);
    return reply.status(201).send(result);
  });
}
