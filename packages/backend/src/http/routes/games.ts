import type { FastifyInstance } from 'fastify';
import type { GamesInfo } from '../../contract.js';
import { GAMES } from '../../games/registry.js';

// The games WorldFoundry knows, with their disclaimers. Static facts only, so the list is the same for every user.
export function registerGameRoutes(app: FastifyInstance): void {
  app.get('/api/games', async (): Promise<GamesInfo> => ({ games: [...GAMES] }));
}
