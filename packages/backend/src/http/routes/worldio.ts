import type { FastifyInstance } from 'fastify';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import type { AppContext } from '../../app.js';
import { LOADERS } from '../../db/enums.js';
import { CreateServerSchema } from '../../servers/schemas.js';
import { AppError } from '../errors.js';

const serverParams = z.object({ serverId: z.string().min(1).max(100) });
const backupParams = serverParams.extend({ backupId: z.string().min(1).max(100) });
const exportParams = z.object({ exportId: z.string().min(1).max(100) });
const importParams = z.object({ importId: z.string().min(1).max(100) });

const exportBody = z
  .object({
    format: z.enum(['zip', 'tar.gz']).default('zip'),
    mods: z.enum(['none', 'manifest', 'jars']).default('none'),
    includeConfig: z.boolean().default(false),
  })
  .strict();
const backupExportBody = z.object({ format: z.enum(['zip', 'tar.gz']).default('zip') }).strict();
const uploadQuery = z.object({ serverId: z.string().min(1).max(100).optional() });
const reviewBody = z.object({ loader: z.enum(LOADERS), mcVersion: z.string().trim().min(1).max(64) }).strict();
const acknowledged = z.array(z.string().max(60)).max(30).default([]);
const selectionBody = z
  .object({
    jars: z.array(z.string().min(1).max(600)).max(3000).default([]),
    install: z
      .array(z.object({ key: z.string().min(1).max(600), projectId: z.string().min(1).max(64), versionId: z.string().min(1).max(64).optional() }).strict())
      .max(500)
      .default([]),
  })
  .strict();
const createBody = z
  .object({
    server: CreateServerSchema,
    importConfig: z.boolean().default(false),
    selection: selectionBody.default({ jars: [], install: [] }),
    acknowledged,
  })
  .strict();
const replaceBody = z.object({ importId: z.string().min(1).max(100), acknowledged }).strict();

// The browser saves a download under this name; ASCII only, so the header needs no encoding tricks
const headerName = (name: string): string => name.replace(/[^A-Za-z0-9._-]/g, '_');

export function registerWorldIoRoutes(app: FastifyInstance, { services }: AppContext): void {
  const { exports: exporter, imports, update } = services;
  // like starting a server: no new work on servers and worlds while an update is stopping and replacing everything
  const guardUpdate = (): void => {
    const blocked = update.startGuard();
    if (blocked !== null) throw blocked;
  };
  const MIB = 1024 * 1024;

  // ---- export -------------------------------------------------------------------------------

  app.post('/api/servers/:serverId/exports', async (request, reply) => {
    guardUpdate();
    const { serverId } = serverParams.parse(request.params);
    const body = exportBody.parse(request.body ?? {});
    return reply.status(202).send({ export: await exporter.startServerExport(serverId, body) });
  });

  app.post('/api/servers/:serverId/backups/:backupId/export', async (request, reply) => {
    guardUpdate();
    const { serverId, backupId } = backupParams.parse(request.params);
    const body = backupExportBody.parse(request.body ?? {});
    return reply.status(202).send({ export: await exporter.startBackupExport(serverId, backupId, body.format) });
  });

  app.get('/api/exports/:exportId', async (request) => {
    const { exportId } = exportParams.parse(request.params);
    return { export: exporter.get(exportId) };
  });

  app.delete('/api/exports/:exportId', async (request) => {
    const { exportId } = exportParams.parse(request.params);
    await exporter.remove(exportId);
    return { deleted: true };
  });

  app.get('/api/exports/:exportId/download', async (request, reply) => {
    const { exportId } = exportParams.parse(request.params);
    const { file, size, fileName, format } = await exporter.locate(exportId);
    void reply
      .header('Content-Type', format === 'zip' ? 'application/zip' : 'application/gzip')
      .header('Content-Length', size)
      .header('Content-Disposition', `attachment; filename="${headerName(fileName)}"`)
      .header('Cache-Control', 'no-store');
    return reply.send(exporter.openDownload(file));
  });

  // ---- import -------------------------------------------------------------------------------

  app.get('/api/imports/limits', async () => ({ maxUploadBytes: imports.maxUploadBytes }));

  // The upload is the raw request body (not multipart), so it streams to disk without buffering. It lives in its
  // own scope because the body parser below must not apply to the JSON routes.
  void app.register(async (scope) => {
    scope.addContentTypeParser('*', (_request, payload, done) => {
      done(null, payload);
    });
    scope.post('/api/imports', { bodyLimit: imports.maxUploadBytes + MIB }, async (request, reply) => {
      const query = uploadQuery.parse(request.query);
      const header = request.headers['content-length'];
      const length = header === undefined ? null : Number(header);
      try {
        guardUpdate();
        const job = await imports.upload(request.body as Readable, {
          contentLength: length !== null && Number.isFinite(length) ? length : null,
          serverId: query.serverId ?? null,
        });
        return await reply.status(202).send({ import: job });
      } catch (error) {
        // the rest of a rejected upload is not read; the connection must not wait for it
        if (error instanceof AppError) void reply.header('Connection', 'close');
        throw error;
      }
    });
  });

  app.get('/api/imports/:importId', async (request) => {
    const { importId } = importParams.parse(request.params);
    return { import: imports.get(importId) };
  });

  app.delete('/api/imports/:importId', async (request) => {
    const { importId } = importParams.parse(request.params);
    await imports.cancel(importId);
    return { deleted: true };
  });

  app.post('/api/imports/:importId/review', async (request) => {
    const { importId } = importParams.parse(request.params);
    const body = reviewBody.safeParse(request.body ?? {});
    return imports.review(importId, body.success ? body.data : null);
  });

  app.post('/api/imports/:importId/create-server', async (request, reply) => {
    guardUpdate();
    const { importId } = importParams.parse(request.params);
    const body = createBody.parse(request.body);
    const { server, job } = await imports.createServer(importId, {
      server: body.server,
      importConfig: body.importConfig,
      selection: body.selection,
      acknowledged: body.acknowledged,
    });
    return reply.status(202).send({ server, import: job });
  });

  app.post('/api/servers/:serverId/world/replace', async (request, reply) => {
    guardUpdate();
    const { serverId } = serverParams.parse(request.params);
    const body = replaceBody.parse(request.body);
    return reply.status(202).send({ import: await imports.replaceWorld(serverId, body.importId, { acknowledged: body.acknowledged }) });
  });
}
