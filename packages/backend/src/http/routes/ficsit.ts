import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { FicsitService } from '../../games/satisfactory/ficsit.js';

const serverParams = z.object({ serverId: z.string().min(1).max(100) });
const modParams = serverParams.extend({ reference: z.string().min(1).max(64) });
const searchQuery = z.object({ query: z.string().max(100).default(''), offset: z.coerce.number().int().min(0).max(10_000).default(0) });
const installBody = z.object({ reference: z.string().min(1).max(64) }).strict();

export function registerFicsitRoutes(app: FastifyInstance, ficsit: FicsitService): void {
  app.get('/api/servers/:serverId/ficsit/mods', async (request) => ficsit.list(serverParams.parse(request.params).serverId));

  app.get('/api/servers/:serverId/ficsit/search', async (request) => {
    const { serverId } = serverParams.parse(request.params);
    const { query, offset } = searchQuery.parse(request.query);
    return ficsit.search(serverId, query, offset);
  });

  app.post('/api/servers/:serverId/ficsit/mods', async (request, reply) => {
    const { serverId } = serverParams.parse(request.params);
    return reply.status(201).send(await ficsit.install(serverId, installBody.parse(request.body).reference));
  });

  app.delete('/api/servers/:serverId/ficsit/mods/:reference', async (request) => {
    const { serverId, reference } = modParams.parse(request.params);
    return ficsit.remove(serverId, reference);
  });
}
