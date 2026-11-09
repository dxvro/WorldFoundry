import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../app.js';
import { BanBodySchema, IpBanBodySchema, ipSchema, nameSchema, OpBodySchema, WhitelistBodySchema, WhitelistEnabledBodySchema } from '../../players/schemas.js';

const serverParams = z.object({ serverId: z.string().min(1).max(100) });
const nameParams = serverParams.extend({ name: nameSchema });
const ipParams = serverParams.extend({ ip: ipSchema });

export function registerPlayerRoutes(app: FastifyInstance, { services }: AppContext): void {
  const { players } = services;

  app.get('/api/servers/:serverId/players', async (request) => {
    const { serverId } = serverParams.parse(request.params);
    return players.read(serverId);
  });

  app.post('/api/servers/:serverId/players/whitelist', async (request) => {
    const { serverId } = serverParams.parse(request.params);
    const { name } = WhitelistBodySchema.parse(request.body);
    return players.addWhitelist(serverId, name);
  });

  app.delete('/api/servers/:serverId/players/whitelist/:name', async (request) => {
    const { serverId, name } = nameParams.parse(request.params);
    return players.removeWhitelist(serverId, name);
  });

  app.post('/api/servers/:serverId/players/whitelist-enabled', async (request) => {
    const { serverId } = serverParams.parse(request.params);
    const { enabled } = WhitelistEnabledBodySchema.parse(request.body);
    return players.setWhitelistEnabled(serverId, enabled);
  });

  app.post('/api/servers/:serverId/players/ops', async (request) => {
    const { serverId } = serverParams.parse(request.params);
    return players.addOp(serverId, OpBodySchema.parse(request.body));
  });

  app.delete('/api/servers/:serverId/players/ops/:name', async (request) => {
    const { serverId, name } = nameParams.parse(request.params);
    return players.removeOp(serverId, name);
  });

  app.post('/api/servers/:serverId/players/banned-players', async (request) => {
    const { serverId } = serverParams.parse(request.params);
    const { name, reason } = BanBodySchema.parse(request.body);
    return players.addBan(serverId, name, reason);
  });

  app.delete('/api/servers/:serverId/players/banned-players/:name', async (request) => {
    const { serverId, name } = nameParams.parse(request.params);
    return players.removeBan(serverId, name);
  });

  app.post('/api/servers/:serverId/players/banned-ips', async (request) => {
    const { serverId } = serverParams.parse(request.params);
    const { ip, reason } = IpBanBodySchema.parse(request.body);
    return players.addIpBan(serverId, ip, reason);
  });

  app.delete('/api/servers/:serverId/players/banned-ips/:ip', async (request) => {
    const { serverId, ip } = ipParams.parse(request.params);
    return players.removeIpBan(serverId, ip);
  });
}
