import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../app.js';
import type { SystemUpdateState } from '../../contract.js';
import { AppError } from '../errors.js';

const applyBody = z.object({
  confirm: z.boolean(),
  countdownSeconds: z.number().int().min(0).max(600).optional(),
});
const settingsBody = z.object({ autoCheck: z.boolean() });

// While an update stops the servers and replaces the application, requests that start, install or change servers
// are refused. Stopping, killing and console commands stay possible.
const ALWAYS_ALLOWED = /^\/api\/servers\/[^/]+\/(?:stop|kill|command)$/;

export function registerUpdateRoutes(app: FastifyInstance, { services }: AppContext): void {
  const { update } = services;

  app.addHook('onRequest', async (request) => {
    if (!update.blocking) return;
    if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') return;
    const url = request.url.split('?')[0] ?? '';
    if (!url.startsWith('/api/servers') && !url.startsWith('/api/java')) return;
    if (ALWAYS_ALLOWED.test(url)) return;
    throw new AppError(
      409,
      'UPDATE_IN_PROGRESS',
      'WorldFoundry is being updated. Servers can only be started, installed or changed afterwards.',
    );
  });

  app.get('/api/system/update', async (): Promise<SystemUpdateState> => update.snapshot());

  app.post('/api/system/update/check', async (): Promise<SystemUpdateState> => update.checkNow());

  app.post('/api/system/update/apply', async (request, reply): Promise<SystemUpdateState> => {
    const body = applyBody.parse(request.body ?? {});
    const state = await update.apply({ confirm: body.confirm, ...(body.countdownSeconds === undefined ? {} : { countdownSeconds: body.countdownSeconds }) });
    void reply.status(202);
    return state;
  });

  app.post('/api/system/update/cancel', async (): Promise<SystemUpdateState> => update.cancel());

  app.post('/api/system/update/dismiss', async (): Promise<SystemUpdateState> => update.dismiss());

  app.patch('/api/system/update/settings', async (request): Promise<SystemUpdateState> => {
    const body = settingsBody.parse(request.body ?? {});
    return update.setAutoCheck(body.autoCheck);
  });
}
