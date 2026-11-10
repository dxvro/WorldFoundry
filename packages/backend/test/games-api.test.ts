import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

  it('refuses a game without an adapter and creates nothing', async () => {
    const res = await create({ game: 'satisfactory' });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'GAME_NOT_AVAILABLE', params: { game: 'Satisfactory' } });
    expect((await env.call<{ servers: unknown[] }>('GET', '/api/servers')).body.servers).toHaveLength(0);
  });
});
