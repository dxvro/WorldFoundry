import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import { z } from 'zod';
import type { AppContext } from '../../app.js';
import { DEFAULT_TAIL, MAX_TAIL, readInstallLog } from '../../installer/install-log.js';
import { PROPERTY_CATALOG, PropertiesEntriesPatchSchema } from '../../properties/catalog.js';
import { PropertiesPatchSchema } from '../../properties/typed.js';
import { CreateServerSchema, UpdateServerSchema } from '../../servers/service.js';
import { AppError } from '../errors.js';

const serverParams = z.object({ serverId: z.string().min(1).max(100) });
const deleteQuery = z.object({ confirm: z.enum(['true', 'false']).default('false'), backups: z.enum(['delete', 'keep']).optional() });
const installLogQuery = z.object({ tail: z.coerce.number().int().min(1).max(MAX_TAIL).default(DEFAULT_TAIL) });
const commandBody = z.object({ command: z.string() });
const historyQuery = z.object({ limit: z.coerce.number().int().min(1).max(2000).default(500) });

export function registerServerRoutes(app: FastifyInstance, { services, config }: AppContext): void {
  const { servers, manager, install, properties } = services;

  app.get('/api/servers', async () => ({ servers: await servers.list() }));

  app.post('/api/servers', async (request, reply) => {
    const server = await servers.create(CreateServerSchema.parse(request.body));
    return reply.status(201).send({ server });
  });

  app.get('/api/servers/:serverId', async (request) => {
    const { serverId } = serverParams.parse(request.params);
    return { server: await servers.get(serverId) };
  });

  app.patch('/api/servers/:serverId', async (request) => {
    const { serverId } = serverParams.parse(request.params);
    return servers.update(serverId, UpdateServerSchema.parse(request.body));
  });

  app.delete('/api/servers/:serverId', async (request) => {
    const { serverId } = serverParams.parse(request.params);
    const { confirm, backups } = deleteQuery.parse(request.query);
    if (confirm !== 'true') {
      throw new AppError(400, 'CONFIRMATION_REQUIRED', 'To delete, the parameter confirm=true must be provided.');
    }
    await servers.remove(serverId, backups);
    return { deleted: true };
  });

  app.post('/api/servers/:serverId/install', async (request, reply) => {
    const { serverId } = serverParams.parse(request.params);
    await install.enqueue(serverId, { checkJava: true });
    return reply.status(202).send({ server: await servers.get(serverId) });
  });

  app.get('/api/servers/:serverId/install-log', async (request) => {
    const { serverId } = serverParams.parse(request.params);
    const { tail } = installLogQuery.parse(request.query);
    await servers.get(serverId);
    return readInstallLog(path.join(config.serversDir, serverId), tail);
  });

  app.post('/api/servers/:serverId/start', async (request) => {
    const { serverId } = serverParams.parse(request.params);
    const result = await manager.start(serverId);
    return { status: result.status, warnings: result.warnings, warningRefs: result.warningRefs };
  });

  app.post('/api/servers/:serverId/stop', async (request) => {
    const { serverId } = serverParams.parse(request.params);
    return { status: await manager.stop(serverId) };
  });

  app.post('/api/servers/:serverId/restart', async (request) => {
    const { serverId } = serverParams.parse(request.params);
    const result = await manager.restart(serverId);
    return { status: result.status, warnings: result.warnings, warningRefs: result.warningRefs };
  });

  app.post('/api/servers/:serverId/kill', async (request) => {
    const { serverId } = serverParams.parse(request.params);
    return { status: await manager.kill(serverId) };
  });

  app.post('/api/servers/:serverId/command', async (request) => {
    const { serverId } = serverParams.parse(request.params);
    const { command } = commandBody.parse(request.body);
    await manager.sendCommand(serverId, command);
    return { sent: true };
  });

  app.get('/api/servers/:serverId/console/history', async (request) => {
    const { serverId } = serverParams.parse(request.params);
    const { limit } = historyQuery.parse(request.query);
    await servers.get(serverId);
    return { lines: manager.history(serverId, limit) };
  });

  app.get('/api/servers/:serverId/properties', async (request) => {
    const { serverId } = serverParams.parse(request.params);
    return properties.read(serverId);
  });

  app.patch('/api/servers/:serverId/properties', async (request) => {
    const { serverId } = serverParams.parse(request.params);
    return properties.patch(serverId, PropertiesPatchSchema.parse(request.body));
  });

  app.put('/api/servers/:serverId/properties/entries', async (request) => {
    const { serverId } = serverParams.parse(request.params);
    return properties.setEntries(serverId, PropertiesEntriesPatchSchema.parse(request.body));
  });

  app.get('/api/properties/catalog', async () => ({ catalog: PROPERTY_CATALOG }));
}
