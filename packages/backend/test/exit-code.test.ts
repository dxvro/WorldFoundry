import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppEvent } from '../src/events/bus.js';
import { normalizeExitCode } from '../src/process/exit-code.js';
import type { ServerProcess } from '../src/process/spawner.js';
import { ServerEnv, waitFor } from './server-env.js';

describe('normalizeExitCode', () => {
  it('maps the unsigned 32-bit spelling of negative codes back and leaves the rest alone', () => {
    expect(normalizeExitCode(4294967295)).toBe(-1);
    expect(normalizeExitCode(0xc000013a)).toBe(-1073741510);
    expect(normalizeExitCode(0x7fffffff)).toBe(2147483647);
    expect(normalizeExitCode(0)).toBe(0);
    expect(normalizeExitCode(1)).toBe(1);
    expect(normalizeExitCode(-1)).toBe(-1);
    expect(normalizeExitCode(null)).toBeNull();
    expect(normalizeExitCode(0x1_0000_0000)).toBe(0x1_0000_0000);
  });
});

describe('externally killed process on Windows', () => {
  let env: ServerEnv;
  let events: AppEvent[];
  beforeEach(async () => {
    env = await ServerEnv.create();
    events = [];
    env.services.bus.subscribe((event) => events.push(event));
  });
  afterEach(async () => {
    await env.close();
  });

  it('reports exit code -1 in the status, the crashed event and the database', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      pid: 2_000_000_000,
      exitCode: null as number | null,
      kill: () => true,
    }) as unknown as ServerProcess;
    env.spawner.spawn = () => {
      setImmediate(() => child.emit('spawn'));
      return child;
    };
    const server = await env.addServer();
    expect((await env.call('POST', `/api/servers/${server.id}/start`)).status).toBe(200);
    child.emit('close', 4294967295, null);

    const status = await env.waitState(server.id, 'crashed');
    expect(status.exitCode).toBe(-1);
    expect(status.message).toContain('exit code -1');
    expect(events.find((event) => event.type === 'server.crashed')).toMatchObject({ exitCode: -1 });
    await waitFor(async () => (await env.row(server.id))?.lastExitCode === -1 || undefined);
  });
});
