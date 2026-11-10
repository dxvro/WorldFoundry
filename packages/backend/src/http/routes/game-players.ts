import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { GamePlayersService } from '../../games/players.js';

const serverParams = z.object({ serverId: z.string().min(1).max(100) });
const actionParams = serverParams.extend({ action: z.string().regex(/^[a-z-]{1,30}$/) });
const actionBody = z.object({ name: z.string().max(100) }).strict();

export function registerGamePlayerRoutes(app: FastifyInstance, players: GamePlayersService): void {
  app.get('/api/servers/:serverId/game-players', async (request) => players.view(serverParams.parse(request.params).serverId));

  app.post('/api/servers/:serverId/game-players/:action', async (request) => {
    const { serverId, action } = actionParams.parse(request.params);
    return players.act(serverId, action, actionBody.parse(request.body).name);
  });
}
