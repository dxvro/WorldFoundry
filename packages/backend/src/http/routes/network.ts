import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../app.js';
import type { NetworkInput, NetworkState, RestartPlan } from '../../contract.js';
import { AppError } from '../errors.js';

const networkBody = z.object({
  bindHost: z.string().max(100).nullable().optional(),
  port: z.number().nullable().optional(),
  allowedHosts: z.array(z.string().max(300)).max(100).optional(),
  publicAddress: z.string().max(300).nullable().optional(),
});
const restartBody = z.object({ confirm: z.boolean().optional() });

export function registerNetworkRoutes(app: FastifyInstance, { services }: AppContext): void {
  const { network, restart } = services;

  app.get('/api/system/network', async (): Promise<NetworkState> => network.state());

  app.put('/api/system/network', async (request): Promise<NetworkState> => {
    const body = networkBody.parse(request.body ?? {});
    const input: NetworkInput = {
      ...(body.bindHost === undefined ? {} : { bindHost: body.bindHost }),
      ...(body.port === undefined ? {} : { port: body.port }),
      ...(body.allowedHosts === undefined ? {} : { allowedHosts: body.allowedHosts }),
      ...(body.publicAddress === undefined ? {} : { publicAddress: body.publicAddress }),
    };
    return network.save(input);
  });

  // Stops all Minecraft servers cleanly, exits with the restart code and starts the servers again afterwards.
  app.post('/api/system/restart', async (request, reply): Promise<RestartPlan> => {
    const body = restartBody.parse(request.body ?? {});
    if (body.confirm !== true) {
      throw new AppError(422, 'RESTART_CONFIRM_REQUIRED', 'The restart must be explicitly confirmed: all running Minecraft servers will be stopped and started again afterwards.');
    }
    const plan = await restart.request();
    void reply.status(202);
    return plan;
  });
}
