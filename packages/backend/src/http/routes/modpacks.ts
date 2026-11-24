import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ModpackService } from '../../modpacks/service.js';

const searchQuery = z.object({
  query: z.string().max(100).default(''),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});
const projectParams = z.object({ projectId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) });

// Modrinth modpacks for the "new server" assistant; a server is created from one with POST /api/servers { modpack }
export function registerModpackRoutes(app: FastifyInstance, modpacks: ModpackService): void {
  app.get('/api/modpacks/search', async (request) => {
    const { query, limit, offset } = searchQuery.parse(request.query);
    return modpacks.search(query, offset, limit);
  });

  app.get('/api/modpacks/:projectId/versions', async (request) => {
    const { projectId } = projectParams.parse(request.params);
    return { versions: await modpacks.versions(projectId) };
  });
}
