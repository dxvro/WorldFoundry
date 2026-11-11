import { describe, expect, it } from 'vitest';
import { GAMES, assertGameAvailable, gameDefinition, isGameId } from '../src/games/registry.js';
import { GAME_IDS } from '../src/games/types.js';
import { CreateServerSchema } from '../src/servers/schemas.js';

describe('game registry', () => {
  it('has exactly one definition per game id', () => {
    expect(GAMES.map((game) => game.id).sort()).toEqual([...GAME_IDS].sort());
  });

  it('carries a disclaimer that names every rights holder family and never claims an endorsement', () => {
    for (const game of GAMES) {
      expect(game.disclaimer, game.id).toMatch(/^Not an official .+ product\. Not approved by or associated with .+\.$/);
      expect(game.rightsHolders.length, game.id).toBeGreaterThan(0);
    }
    expect(gameDefinition('minecraft').disclaimer).toBe('Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft.');
  });

  it('describes every game in its own words and gives a rough size for planning', () => {
    for (const game of GAMES) {
      expect(game.summary.length, game.id).toBeGreaterThan(10);
      expect(game.summary, game.id).not.toMatch(/official/i);
      expect(game.diskGb, game.id).toBeGreaterThan(0);
      expect(game.ramGb, game.id).toBeGreaterThan(0);
    }
  });

  it('never ships game files: every game is fetched from its vendor or through SteamCMD with an anonymous login', () => {
    for (const game of GAMES) {
      if (game.delivery.kind === 'steamcmd') expect(game.delivery.anonymous, game.id).toBe(true);
      else expect(game.delivery.kind).toBe('vendor-download');
    }
  });

  it('keeps API keys out of the project: a source that needs one says so', () => {
    const curseforge = gameDefinition('minecraft').modSources.find((source) => source.id === 'curseforge');
    expect(curseforge?.requiresKey).toBe(true);
    for (const game of GAMES) expect(game.modSources.length, game.id).toBeGreaterThan(0);
  });

  it('only lets servers be created for available games', () => {
    expect(assertGameAvailable('minecraft').id).toBe('minecraft');
    for (const game of GAMES.filter((entry) => entry.availability === 'planned')) {
      expect(() => assertGameAvailable(game.id), game.id).toThrowError(expect.objectContaining({ code: 'GAME_NOT_AVAILABLE', statusCode: 422, params: { game: game.name } }));
    }
  });

  it('recognises game ids', () => {
    expect(isGameId('zomboid')).toBe(true);
    expect(isGameId('tetris')).toBe(false);
    expect(isGameId(undefined)).toBe(false);
  });
});

describe('create request', () => {
  const base = { name: 'Survival', loader: 'vanilla', mcVersion: '1.21.1' };

  it('accepts a request without a game and one that names a known game', () => {
    expect(CreateServerSchema.parse(base).game).toBeUndefined();
    expect(CreateServerSchema.parse({ ...base, game: 'minecraft' }).game).toBe('minecraft');
  });

  it('rejects an unknown game', () => {
    expect(CreateServerSchema.safeParse({ ...base, game: 'tetris' }).success).toBe(false);
  });
});
