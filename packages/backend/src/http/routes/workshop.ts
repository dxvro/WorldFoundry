import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { WorkshopSaveSchema, type ZomboidWorkshopService } from '../../games/zomboid/workshop.js';

const serverParams = z.object({ serverId: z.string().min(1).max(100) });
const lookupQuery = z.object({ q: z.string().min(1).max(500) });

export function registerWorkshopRoutes(app: FastifyInstance, workshop: ZomboidWorkshopService): void {
  app.get('/api/workshop/lookup', async (request) => ({ item: await workshop.lookup(lookupQuery.parse(request.query).q) }));

  app.get('/api/servers/:serverId/workshop', async (request) => workshop.get(serverParams.parse(request.params).serverId));

  app.put('/api/servers/:serverId/workshop', async (request) => workshop.save(serverParams.parse(request.params).serverId, WorkshopSaveSchema.parse(request.body)));
}
