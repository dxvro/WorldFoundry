import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { servers } from '../src/db/schema.js';
import { EventBus } from '../src/events/bus.js';
import { GameAdapters } from '../src/games/adapters.js';
import { gameDefinition } from '../src/games/registry.js';
import type { GameAdapter, StartPlan } from '../src/games/types.js';
import { KeyedLock } from '../src/lib/keyed-lock.js';
import { msg } from '../src/messages.js';
import { ProcessManager } from '../src/process/manager.js';
import { realSpawner } from '../src/process/spawner.js';
import { createTestDb, serverRow, type TestDb } from './helpers.js';
import { waitFor } from './server-env.js';

// A game that is not Minecraft: no Java, its own ready line, its own player lines and its own stop command.
// It proves that the core runs a process only through the adapter.
const SCRIPT = `
const rl = require('node:readline').createInterface({ input: process.stdin });
console.log('booting');
setTimeout(() => { console.log('*** SERVER READY ***'); console.log('+ Alice'); }, 20);
rl.on('line', (line) => {
  if (line === 'quit') { console.log('saving'); process.exit(0); }
  if (line === 'leave') console.log('- Alice');
});
`;

class OtherGame implements GameAdapter {
  readonly definition = gameDefinition('zomboid');
  readonly stopCommand = 'quit';
  planned: string[] = [];

  installTitle(): string {
    return 'other';
  }
  async validateInstall(): Promise<void> {}
  async install(): Promise<Record<string, never>> {
    return {};
  }
  async planStart(server: { id: string; port: number }, dir: string): Promise<StartPlan> {
    this.planned.push(dir);
    return {
      kind: 'launch',
      plan: {
        command: process.execPath,
        args: ['-e', SCRIPT],
        port: server.port,
        startLine: msg('SERVER_STOPPING'),
        notes: [],
        beforeSpawn: async () => undefined,
        javaPath: null,
      },
    };
  }
  async backupLayout(): Promise<never> {
    throw new Error('not used');
  }
  classifyLine(line: string) {
    if (line === '*** SERVER READY ***') return { type: 'done' as const };
    if (line.startsWith('+ ')) return { type: 'join' as const, name: line.slice(2) };
    if (line.startsWith('- ')) return { type: 'leave' as const, name: line.slice(2) };
    return null;
  }
}

let t: TestDb;
let manager: ProcessManager;
let game: OtherGame;
beforeEach(async () => {
  t = await createTestDb();
  game = new OtherGame();
  manager = new ProcessManager({
    db: t.db,
    serversDir: path.join(t.dir, 'servers'),
    lock: new KeyedLock(),
    spawner: realSpawner,
    games: new GameAdapters([game]),
    bus: new EventBus(),
    probePort: async () => 'free',
    metricsIntervalMs: 60_000,
  });
  await mkdir(path.join(t.dir, 'servers', 's1'), { recursive: true });
  await t.db.insert(servers).values(serverRow('s1', { game: 'zomboid', installState: 'installed', port: 16261 }));
});
afterEach(async () => {
  await manager.shutdown(5_000);
  await t.cleanup();
});

describe('a game adapter drives the process', () => {
  it('starts the command of the adapter, reads readiness and players through it and stops with its command', async () => {
    await manager.start('s1');
    expect(game.planned).toEqual([path.join(t.dir, 'servers', 's1')]);
    await waitFor(() => (manager.status('s1').state === 'online' && manager.status('s1').players.length === 1) || undefined);
    expect(manager.status('s1')).toMatchObject({ state: 'online', port: 16261, players: ['Alice'] });

    await manager.sendCommand('s1', 'leave');
    await waitFor(() => manager.status('s1').players.length === 0 || undefined);

    await manager.stop('s1');
    await waitFor(() => manager.status('s1').state === 'offline' || undefined);
    expect(manager.history('s1').map((line) => line.text)).toContain('saving');
  });

  it('refuses a server of a game without an adapter', async () => {
    await t.db.insert(servers).values(serverRow('s2', { game: 'ark', installState: 'installed' }));
    await expect(manager.start('s2')).rejects.toMatchObject({ code: 'GAME_NOT_AVAILABLE' });
  });
});
