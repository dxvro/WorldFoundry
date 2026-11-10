import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GameAdapters } from '../src/games/adapters.js';
import { ServerEnv } from './server-env.js';

interface GamesBody {
  games: Array<{ id: string; availability: string; disclaimer: string }>;
}
interface CreateBody {
  server?: { id: string; game: string };
  error?: { code: string; params?: Record<string, unknown> };
}

let env: ServerEnv;
beforeEach(async () => {
  env = await ServerEnv.create();
});
afterEach(async () => {
  await env.close();
});

const create = (body: Record<string, unknown>) => env.call<CreateBody>('POST', '/api/servers', { name: 'Test', loader: 'vanilla', mcVersion: '1.21.1', ...body });

describe('GET /api/games', () => {
  it('lists every game with its disclaimer', async () => {
    const res = await env.call<GamesBody>('GET', '/api/games');
    expect(res.status).toBe(200);
    expect(res.body.games.map((game) => game.id)).toEqual(['minecraft', 'zomboid', 'satisfactory', 'ark']);
    for (const game of res.body.games) expect(game.disclaimer).toMatch(/^Not an official /);
  });
});

describe('the game of a server', () => {
  it('is Minecraft when the request names none, and is returned with the server', async () => {
    const res = await create({});
    expect(res.status).toBe(201);
    expect(res.body.server?.game).toBe('minecraft');
    await env.services.install.idle();
  });

  it('refuses a game whose adapter is missing (a newer database opened by an older version)', () => {
    expect(() => new GameAdapters([]).get('ark')).toThrowError(expect.objectContaining({ code: 'GAME_NOT_AVAILABLE', params: { game: 'ARK: Survival Evolved' } }));
  });

  it('refuses an unknown game', async () => {
    expect((await create({ game: 'tetris' })).status).toBe(422);
  });
});
