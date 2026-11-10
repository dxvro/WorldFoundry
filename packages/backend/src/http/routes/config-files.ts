import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ConfigFilesService } from '../../games/config-files.js';

const serverParams = z.object({ serverId: z.string().min(1).max(100) });
const fileParams = serverParams.extend({ key: z.string().regex(/^[a-z0-9-]{1,40}$/) });
const writeBody = z.object({ text: z.string() }).strict();

export function registerConfigFileRoutes(app: FastifyInstance, files: ConfigFilesService): void {
  app.get('/api/servers/:serverId/config-files', async (request) => ({ files: await files.list(serverParams.parse(request.params).serverId) }));

  app.get('/api/servers/:serverId/config-files/:key', async (request) => {
    const { serverId, key } = fileParams.parse(request.params);
    return files.read(serverId, key);
  });

  app.put('/api/servers/:serverId/config-files/:key', { bodyLimit: 2 * 1024 * 1024 }, async (request) => {
    const { serverId, key } = fileParams.parse(request.params);
    return files.write(serverId, key, writeBody.parse(request.body).text);
  });
}
