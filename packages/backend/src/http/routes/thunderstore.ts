import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ORDERINGS, type ThunderstoreService } from '../../games/valheim/thunderstore.js';

const serverParams = z.object({ serverId: z.string().min(1).max(100) });
const modParams = serverParams.extend({ fullName: z.string().min(3).max(260) });
const searchQuery = z.object({
  query: z.string().max(100).default(''),
  ordering: z.enum(ORDERINGS).default('most-downloaded'),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});
const installBody = z.object({ fullName: z.string().min(3).max(260) }).strict();

// Thunderstore mods of a Valheim server
export function registerThunderstoreRoutes(app: FastifyInstance, thunderstore: ThunderstoreService): void {
  app.get('/api/servers/:serverId/thunderstore/mods', async (request) => thunderstore.list(serverParams.parse(request.params).serverId));

  app.get('/api/servers/:serverId/thunderstore/search', async (request) => {
    const { serverId } = serverParams.parse(request.params);
    const { query, ordering, offset } = searchQuery.parse(request.query);
    return thunderstore.search(serverId, query, ordering, offset);
  });

  app.post('/api/servers/:serverId/thunderstore/mods', async (request, reply) => {
    const { serverId } = serverParams.parse(request.params);
    return reply.status(201).send(await thunderstore.install(serverId, installBody.parse(request.body).fullName));
  });

  app.delete('/api/servers/:serverId/thunderstore/mods/:fullName', async (request) => {
    const { serverId, fullName } = modParams.parse(request.params);
    return thunderstore.remove(serverId, fullName);
  });
}
