import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SEARCH_INDEXES } from '../../modrinth/types.js';
import type { ModService } from '../../mods/service.js';

const serverParams = z.object({ serverId: z.string().min(1) });
const modParams = serverParams.extend({ modId: z.string().min(1) });

const categoryList = z.preprocess(
  (value) => {
    if (value === undefined) return [];
    const parts = Array.isArray(value) ? value : [value];
    return parts.flatMap((part) => (typeof part === 'string' ? part.split(',') : [part])).filter((part) => part !== '');
  },
  z.array(z.string().regex(/^[a-z0-9_-]{1,40}$/i, 'Invalid category')).max(10),
);

const searchQuery = z.object({
  query: z.string().max(100).default(''),
  categories: categoryList,
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
  index: z.enum(SEARCH_INDEXES).default('relevance'),
});

const installBody = z.object({ projectId: z.string().min(1).max(64), versionId: z.string().min(1).max(64).optional() });
const deleteQuery = z.object({ force: z.enum(['true', 'false']).default('false') });
const toggleBody = z.object({ enabled: z.boolean(), force: z.boolean().optional() }).strict();
const applyBody = z.object({ projectIds: z.array(z.string().min(1)).max(500).optional() });
const logQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

export function registerModRoutes(app: FastifyInstance, service: ModService): void {
  app.get('/api/modrinth/categories', async () => ({ categories: await service.categories() }));

  app.get('/api/servers/:serverId/mods', async (request) => {
    const { serverId } = serverParams.parse(request.params);
    return { mods: await service.list(serverId) };
  });

  app.get('/api/servers/:serverId/mods/search', async (request) => {
    const { serverId } = serverParams.parse(request.params);
    return service.search(serverId, searchQuery.parse(request.query));
  });

  app.post('/api/servers/:serverId/mods', async (request, reply) => {
    const { serverId } = serverParams.parse(request.params);
    const body = installBody.parse(request.body);
    const result = await service.install(serverId, body.projectId, body.versionId);
    return reply.status(201).send(result);
  });

  app.delete('/api/servers/:serverId/mods/:modId', async (request) => {
    const { serverId, modId } = modParams.parse(request.params);
    const { force } = deleteQuery.parse(request.query);
    return service.remove(serverId, modId, force === 'true');
  });

  app.patch('/api/servers/:serverId/mods/:modId', async (request) => {
    const { serverId, modId } = modParams.parse(request.params);
    const body = toggleBody.parse(request.body);
    return service.setEnabled(serverId, modId, body.enabled, body.force ?? false);
  });

  app.get('/api/servers/:serverId/mods/backups', async (request) => {
    const { serverId } = serverParams.parse(request.params);
    return service.backups(serverId);
  });

  app.post('/api/servers/:serverId/mods/backups/cleanup', async (request) => {
    const { serverId } = serverParams.parse(request.params);
    return service.cleanBackups(serverId);
  });

  app.post('/api/servers/:serverId/mods/scan', async (request) => {
    const { serverId } = serverParams.parse(request.params);
    return service.scan(serverId);
  });

  app.post('/api/servers/:serverId/mods/updates/check', async (request) => {
    const { serverId } = serverParams.parse(request.params);
    return service.checkUpdates(serverId);
  });

  app.post('/api/servers/:serverId/mods/updates/apply', async (request) => {
    const { serverId } = serverParams.parse(request.params);
    const body = applyBody.parse(request.body ?? {});
    return service.applyUpdates(serverId, body.projectIds);
  });

  app.get('/api/servers/:serverId/mods/update-log', async (request) => {
    const { serverId } = serverParams.parse(request.params);
    const { limit } = logQuery.parse(request.query);
    return { entries: await service.updateLog(serverId, limit) };
  });
}
