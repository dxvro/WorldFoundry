import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { servers } from '../db/schema.js';
import { AppError } from '../http/errors.js';
import type { ProcessManager } from '../process/manager.js';
import type { GameAdapters } from './adapters.js';

// Player names as the games accept them in a quoted console argument
export const PLAYER_NAME = /^[^"\\\r\n\u0000]{1,64}$/;

export interface GamePlayersView {
  online: string[];
  count: number | null;
  actions: Array<{ id: string; label: string; confirm: boolean }>;
  running: boolean;
}

// Players of games other than Minecraft (which has its own lists): who is online, and the admin commands the game offers.
export class GamePlayersService {
  constructor(private readonly options: { db: Db; games: GameAdapters; manager: ProcessManager }) {}

  private async adapter(serverId: string) {
    const row = (await this.options.db.select().from(servers).where(eq(servers.id, serverId)))[0];
    if (row === undefined) throw new AppError(404, 'SERVER_NOT_FOUND', 'The server was not found.');
    if (row.game === 'minecraft') throw new AppError(409, 'GAME_FEATURE_UNSUPPORTED', 'Minecraft servers have their own player lists.', undefined, { game: 'Minecraft' });
    return this.options.games.forServer(row);
  }

  async view(serverId: string): Promise<GamePlayersView> {
    const adapter = await this.adapter(serverId);
    const status = this.options.manager.status(serverId);
    return {
      online: status.players,
      count: status.playerCount ?? null,
      actions: (adapter.playerActions ?? []).map(({ id, label, confirm }) => ({ id, label, confirm })),
      running: status.state === 'online',
    };
  }

  async act(serverId: string, actionId: string, rawName: string): Promise<{ sent: string }> {
    const adapter = await this.adapter(serverId);
    const action = (adapter.playerActions ?? []).find((entry) => entry.id === actionId);
    if (action === undefined) throw new AppError(404, 'PLAYER_ACTION_NOT_FOUND', 'This game does not offer that action.');
    const name = rawName.trim();
    if (!PLAYER_NAME.test(name)) throw new AppError(422, 'PLAYER_NAME_INVALID', 'Invalid player name: 1 to 64 characters, no quotes or backslashes.');
    if (this.options.manager.status(serverId).state !== 'online') throw new AppError(409, 'SERVER_NOT_RUNNING', 'The server is not running.');
    const command = action.command(adapter.resolvePlayer?.(serverId, name) ?? name);
    await this.options.manager.sendCommand(serverId, command);
    return { sent: command };
  }
}
