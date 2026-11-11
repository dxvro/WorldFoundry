import type { FastifyInstance } from 'fastify';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import type { CustomModsService } from '../../games/custom-mods.js';
import { AppError } from '../errors.js';

const serverParams = z.object({ serverId: z.string().min(1).max(100) });
const modParams = serverParams.extend({ modId: z.string().min(1).max(200) });
const uploadQuery = z.object({ fileName: z.string().min(1).max(260).default('upload') });

// Mods the user uploads as a file, for every game (Minecraft: a .jar; the other games: a .zip with the mod folder)
export function registerCustomModRoutes(app: FastifyInstance, mods: CustomModsService, maxUploadBytes: number): void {
  app.get('/api/servers/:serverId/custom-mods', async (request) => mods.list(serverParams.parse(request.params).serverId));

  app.delete('/api/servers/:serverId/custom-mods/:modId', async (request) => {
    const { serverId, modId } = modParams.parse(request.params);
    return mods.remove(serverId, modId);
  });

  // the raw file as the body, streamed to disk; in its own scope so the parser does not touch the JSON routes
  void app.register(async (scope) => {
    scope.addContentTypeParser('*', (_request, payload, done) => {
      done(null, payload);
    });
    scope.post('/api/servers/:serverId/custom-mods', { bodyLimit: maxUploadBytes + 1024 * 1024 }, async (request, reply) => {
      const { serverId } = serverParams.parse(request.params);
      const { fileName } = uploadQuery.parse(request.query);
      const header = request.headers['content-length'];
      const length = header === undefined ? null : Number(header);
      try {
        return await mods.upload(serverId, request.body as Readable, { contentLength: length !== null && Number.isFinite(length) ? length : null, fileName });
      } catch (error) {
        // the rest of a rejected upload is not read; the connection must not wait for it
        if (error instanceof AppError) void reply.header('Connection', 'close');
        throw error;
      }
    });
  });
}
