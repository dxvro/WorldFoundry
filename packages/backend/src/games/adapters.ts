import type { Server } from '../db/schema.js';
import { AppError } from '../http/errors.js';
import { assertGameAvailable } from './registry.js';
import type { GameAdapter, GameId } from './types.js';

// The adapters that exist. A game without one is listed as planned and has no servers.
export class GameAdapters {
  private readonly byId = new Map<GameId, GameAdapter>();

  constructor(adapters: GameAdapter[]) {
    for (const adapter of adapters) this.byId.set(adapter.definition.id, adapter);
  }

  get(id: GameId): GameAdapter {
    const adapter = this.byId.get(id);
    // a row of a game whose adapter is missing (a newer database opened by an older version)
    if (adapter === undefined) {
      const game = assertGameAvailable(id);
      throw new AppError(422, 'GAME_NOT_AVAILABLE', `Servers for ${game.name} cannot be created yet.`, undefined, { game: game.name });
    }
    return adapter;
  }

  forServer(server: Pick<Server, 'game'>): GameAdapter {
    return this.get(server.game);
  }
}
