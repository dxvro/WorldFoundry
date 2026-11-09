import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppEvent } from '../src/events/bus.js';
import { AppError } from '../src/http/errors.js';
import { ServerEnv, freePort, wait, waitFor } from './server-env.js';

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

let env: ServerEnv;
let events: AppEvent[];
let unsubscribe: () => void;

async function setup(options: Parameters<typeof ServerEnv.create>[0] = {}): Promise<void> {
  env = await ServerEnv.create(options);
  events = [];
  unsubscribe = env.services.bus.subscribe((event) => events.push(event));
}

beforeEach(async () => {
  await setup();
});
afterEach(async () => {
  unsubscribe();
  await env.close();
});

const start = (id: string) => env.call<{ status: { state: string; pid: number }; warnings: string[] }>('POST', `/api/servers/${id}/start`);
const lineTexts = (id: string): string[] => env.services.manager.history(id).map((line) => line.text);

describe('start preconditions', () => {
  it.each(['pending', 'installing', 'failed'] as const)('refuses an install state of %s with SERVER_NOT_INSTALLED', async (installState) => {
    const server = await env.addServer({ installState });
    const res = await env.call<ErrorBody>('POST', `/api/servers/${server.id}/start`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SERVER_NOT_INSTALLED');
    expect(env.spawner.calls).toHaveLength(0);
  });

  it('refuses unknown servers with 404', async () => {
    const res = await env.call<ErrorBody>('POST', '/api/servers/00000000-0000-4000-8000-000000000000/start');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('SERVER_NOT_FOUND');
  });

  it('requires the EULA and never writes eula=true without acceptance', async () => {
    const server = await env.addServer({ eulaAccepted: false });
    const res = await env.call<ErrorBody>('POST', `/api/servers/${server.id}/start`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EULA_NOT_ACCEPTED');
    expect(res.body.error.message).toContain('EULA');
    expect(await readdir(env.serverDir(server.id))).not.toContain('eula.txt');
    expect(env.spawner.calls).toHaveLength(0);
  });

  it('writes eula=true only after the user accepted via PATCH', async () => {
    const server = await env.addServer({ eulaAccepted: false });
    expect((await env.call('PATCH', `/api/servers/${server.id}`, { eulaAccepted: true })).status).toBe(200);
    expect((await start(server.id)).status).toBe(200);
    expect(await readFile(path.join(env.serverDir(server.id), 'eula.txt'), 'utf8')).toContain('eula=true');
  });

  it('withdrawing the consent rewrites an existing eula.txt to false', async () => {
    const server = await env.addServer({ eulaAccepted: true });
    await writeFile(path.join(env.serverDir(server.id), 'eula.txt'), 'eula=true\n');
    expect((await env.call('PATCH', `/api/servers/${server.id}`, { eulaAccepted: false })).status).toBe(200);
    expect(await readFile(path.join(env.serverDir(server.id), 'eula.txt'), 'utf8')).toContain('eula=false');
    expect((await start(server.id)).status).toBe(409);
  });

  it('answers JAVA_NOT_FOUND when no runtime exists and never spawns', async () => {
    await env.close();
    unsubscribe();
    await setup({ java: {} });
    const server = await env.addServer();
    const res = await start(server.id);
    expect(res.status).toBe(422);
    expect((res.body as unknown as ErrorBody).error.code).toBe('JAVA_NOT_FOUND');
    expect(env.spawner.calls).toHaveLength(0);
  });

  it('answers JAVA_VERSION_INCOMPATIBLE with required and found', async () => {
    await env.close();
    unsubscribe();
    await setup({ java: { 'C:\\j\\java8\\bin\\java.exe': '1.8.0_392' } });
    const server = await env.addServer({ requiredJavaMajor: 21 });
    const res = await env.call<ErrorBody>('POST', `/api/servers/${server.id}/start`);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('JAVA_VERSION_INCOMPATIBLE');
    expect(res.body.error.details).toMatchObject({ required: 21, found: [8] });
  });

  it('answers JAVA_NOT_FOUND for a configured path that does not exist', async () => {
    const server = await env.addServer({ javaPath: 'C:\\does\\not\\exist\\java.exe' });
    const res = await env.call<ErrorBody>('POST', `/api/servers/${server.id}/start`);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('JAVA_NOT_FOUND');
  });

  it('refuses a port that a real listening socket occupies and names the port', async () => {
    const port = await freePort();
    const server = await env.addServer({ port });
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(port, '0.0.0.0', resolve));
    try {
      const res = await env.call<ErrorBody>('POST', `/api/servers/${server.id}/start`);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PORT_IN_USE');
      expect(res.body.error.message).toContain(String(port));
      expect(env.spawner.calls).toHaveLength(0);
      expect(env.services.manager.status(server.id).state).toBe('offline');
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
    // once the port is free again the very same server starts
    const again = await env.call('POST', `/api/servers/${server.id}/start`);
    expect(again.status).toBe(200);
  });

  it('takes the port from server.properties and syncs the database', async () => {
    const server = await env.addServer({ port: 25000 });
    const port = await freePort();
    await writeFile(path.join(env.serverDir(server.id), 'server.properties'), `server-port=${port}\n`);
    const res = await start(server.id);
    expect(res.status).toBe(200);
    expect(env.services.manager.status(server.id).port).toBe(port);
    expect((await env.row(server.id))?.port).toBe(port);
  });

  it('creates server.properties with the database port when absent', async () => {
    const server = await env.addServer();
    await start(server.id);
    const text = await readFile(path.join(env.serverDir(server.id), 'server.properties'), 'utf8');
    expect(text).toBe(`server-port=${server.port}\n`);
  });

  it('refuses a port used by another managed server and names it', async () => {
    const first = await env.addServer({ name: 'Survival' });
    expect((await start(first.id)).status).toBe(200);
    const second = await env.addServer({ name: 'Creative', port: first.port });
    const res = await env.call<ErrorBody>('POST', `/api/servers/${second.id}/start`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PORT_IN_USE');
    expect(res.body.error.message).toContain('Survival');
    expect(res.body.error.details).toMatchObject({ port: first.port, serverName: 'Survival' });
  });

  it('refuses a second start of a running server', async () => {
    const server = await env.addServer();
    await start(server.id);
    const res = await env.call<ErrorBody>('POST', `/api/servers/${server.id}/start`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SERVER_ALREADY_RUNNING');
  });

  it('two concurrent starts for one port: one wins, the other gets PORT_IN_USE', async () => {
    const a = await env.addServer({ name: 'A' });
    const b = await env.addServer({ name: 'B', port: a.port });
    const results = await Promise.all([start(a.id), start(b.id)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });
});

describe('running a server', () => {
  it('goes starting -> online, builds the command line and records the start', async () => {
    const server = await env.addServer({ minRamMb: 512, maxRamMb: 1536, extraJvmArgs: '-Dfoo="a b"' });
    const res = await start(server.id);
    expect(res.status).toBe(200);
    expect(res.body.status.state).toBe('starting');
    expect(res.body.status.pid).toBeGreaterThan(0);
    const online = await env.waitState(server.id, 'online');
    expect(online.startedAt).not.toBeNull();

    const call = env.spawner.calls[0];
    expect(call?.command).toBe(env.javaPath);
    expect(call?.cwd).toBe(env.serverDir(server.id));
    const { args } = await env.readFakeArgs(server.id);
    expect(args.slice(0, 2)).toEqual(['-Xms512M', '-Xmx1536M']);
    expect(args).toContain('-Dfoo=a b');
    expect(args.slice(-3)).toEqual(['-jar', 'server.jar', 'nogui']);
    expect(args).toContain('-Dfile.encoding=UTF-8');
    expect((await env.row(server.id))?.lastStartedAt).toBeInstanceOf(Date);

    const states = events.filter((e) => e.type === 'server.status').map((e) => (e.type === 'server.status' ? e.status.state : ''));
    expect(states).toEqual(expect.arrayContaining(['starting', 'online']));
  });

  it('launches modern Forge via @argsfile of the current platform', async () => {
    const server = await env.addServer({
      loader: 'forge',
      launchSpec: JSON.stringify({ kind: 'args', unixFile: 'libraries/f/unix_args.txt', winFile: 'libraries/f/win_args.txt' }),
    });
    await mkdir(path.join(env.serverDir(server.id), 'libraries', 'f'), { recursive: true });
    const file = process.platform === 'win32' ? 'win_args.txt' : 'unix_args.txt';
    await writeFile(path.join(env.serverDir(server.id), 'libraries', 'f', file), '');
    expect((await start(server.id)).status).toBe(200);
    const { args } = await env.readFakeArgs(server.id);
    expect(args.slice(-2)).toEqual([`@libraries/f/${file}`, 'nogui']);
    expect(args).not.toContain('-jar');
  });

  it('reports missing launch files as SERVER_FILES_MISSING', async () => {
    const server = await env.addServer({ launchSpec: JSON.stringify({ kind: 'jar', jar: 'missing.jar' }) });
    const res = await env.call<ErrorBody>('POST', `/api/servers/${server.id}/start`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SERVER_FILES_MISSING');
  });

  it('tracks players from anchored lines only and resets them on exit', async () => {
    const server = await env.addServer();
    await start(server.id);
    await env.waitState(server.id, 'online');
    const send = (command: string) => env.services.manager.sendCommand(server.id, command);
    await send('join Steve');
    await send('chat Bob Alex joined the game');
    await send('say Mallory joined the game');
    await send('join Alex');
    await waitFor(() => env.services.manager.status(server.id).players.length === 2 || undefined);
    expect(env.services.manager.status(server.id).players.sort()).toEqual(['Alex', 'Steve']);
    await send('leave Steve');
    await waitFor(() => env.services.manager.status(server.id).players.length === 1 || undefined);
    expect(env.services.manager.status(server.id).players).toEqual(['Alex']);
    await send('chat Bob Done (1.0s)! For help, type "help"');
    await send('stop');
    await env.waitState(server.id, 'offline');
    expect(env.services.manager.status(server.id).players).toEqual([]);
  });

  it('does not turn online from a chat message that looks like Done', async () => {
    env.spawner.mode = 'silent';
    const server = await env.addServer();
    await start(server.id);
    await env.services.manager.sendCommand(server.id, 'chat Bob Done (1.0s)! For help, type "help"');
    await waitFor(() => lineTexts(server.id).some((text) => text.includes('<Bob>')) || undefined);
    expect(env.services.manager.status(server.id).state).toBe('starting');
    await env.services.manager.kill(server.id);
    await env.waitState(server.id, 'offline');
  });

  it('works with the Paper log format', async () => {
    env.spawner.format = 'paper';
    const server = await env.addServer();
    await start(server.id);
    await env.waitState(server.id, 'online');
    await env.services.manager.sendCommand(server.id, 'join Steve');
    await waitFor(() => env.services.manager.status(server.id).players.includes('Steve') || undefined);
  });

  it('works with Forge-style log lines', async () => {
    env.spawner.format = 'forge';
    const server = await env.addServer();
    await start(server.id);
    await env.waitState(server.id, 'online');
  });

  it('warns once when the start takes long, without killing the server', async () => {
    await env.close();
    unsubscribe();
    await setup({ startWarningMs: 100 });
    env.spawner.mode = 'silent';
    const server = await env.addServer();
    await start(server.id);
    await waitFor(() => lineTexts(server.id).some((text) => text.includes('has not reported being started yet')) || undefined);
    expect(env.services.manager.status(server.id).state).toBe('starting');
    expect(lineTexts(server.id).filter((text) => text.includes('has not reported being started yet'))).toHaveLength(1);
  });
});

describe('console output', () => {
  it('decodes UTF-8 split across single bytes', async () => {
    const server = await env.addServer();
    await start(server.id);
    await env.waitState(server.id, 'online');
    await env.services.manager.sendCommand(server.id, 'utf8');
    await waitFor(() => lineTexts(server.id).includes('Grüße ☃ 😀 done') || undefined);
  });

  it('handles CRLF, tags stderr and caps overlong lines', async () => {
    const server = await env.addServer();
    await start(server.id);
    await env.waitState(server.id, 'online');
    const { manager } = env.services;
    await manager.sendCommand(server.id, 'crlf');
    await manager.sendCommand(server.id, 'stderr broken');
    await manager.sendCommand(server.id, 'long');
    await waitFor(() => manager.history(server.id).some((line) => line.text.endsWith('[...]')) || undefined);
    const lines = manager.history(server.id);
    expect(lines.find((l) => l.text === 'crlf one')).toMatchObject({ stream: 'stdout' });
    expect(lines.find((l) => l.text === 'crlf two')).toBeDefined();
    expect(lines.find((l) => l.text === 'broken')).toMatchObject({ stream: 'stderr' });
    const long = lines.find((l) => l.text.endsWith('[...]'));
    expect(long?.text.length).toBeLessThan(9000);
    expect(lines.map((l) => l.seq)).toEqual([...lines.map((l) => l.seq)].sort((a, b) => a - b));
  });

  it('keeps at most 2000 lines of history', async () => {
    const server = await env.addServer();
    await start(server.id);
    await env.waitState(server.id, 'online');
    const { manager } = env.services;
    for (let i = 0; i < 2100; i++) await manager.sendCommand(server.id, `raw line-${i}`);
    await waitFor(() => manager.history(server.id).some((l) => l.text === 'line-2099') || undefined, 15_000);
    const lines = manager.history(server.id);
    expect(lines.length).toBeLessThanOrEqual(2000);
    expect(lines.some((l) => l.text === 'line-0')).toBe(false);
    const res = await env.call<{ lines: unknown[] }>('GET', `/api/servers/${server.id}/console/history?limit=50`);
    expect(res.body.lines).toHaveLength(50);
  }, 30_000);
});

describe('commands', () => {
  it('rejects newlines, empty and overlong commands and offline servers', async () => {
    const server = await env.addServer();
    const offline = await env.call<ErrorBody>('POST', `/api/servers/${server.id}/command`, { command: 'list' });
    expect(offline.status).toBe(409);
    expect(offline.body.error.code).toBe('SERVER_NOT_RUNNING');

    await start(server.id);
    await env.waitState(server.id, 'online');
    for (const command of ['say hi\nstop', 'say hi\rstop', 'a\r\nb', '', '   ', 'x'.repeat(1025)]) {
      const res = await env.call<ErrorBody>('POST', `/api/servers/${server.id}/command`, { command });
      expect(res.status, JSON.stringify(command)).toBe(422);
      expect(res.body.error.code).toBe('INVALID_COMMAND');
    }
    expect(env.services.manager.status(server.id).state).toBe('online');
    expect(lineTexts(server.id).some((t) => t.endsWith('Stopping the server'))).toBe(false);

    const ok = await env.call('POST', `/api/servers/${server.id}/command`, { command: 'x'.repeat(1024).replace(/x/g, 'a') });
    expect(ok.status).toBe(200);
    const sent = await env.call('POST', `/api/servers/${server.id}/command`, { command: 'say Hello' });
    expect(sent.status).toBe(200);
    await waitFor(() => lineTexts(server.id).some((t) => t.endsWith('[Server] Hello')) || undefined);
  });

  it('treats a typed stop as an expected shutdown', async () => {
    const server = await env.addServer();
    await start(server.id);
    await env.waitState(server.id, 'online');
    await env.services.manager.sendCommand(server.id, 'stop');
    expect(env.services.manager.status(server.id).state).toBe('stopping');
    const status = await env.waitState(server.id, 'offline');
    expect(status.exitCode).toBe(0);
  });
});

describe('stopping', () => {
  it('stops gracefully via stdin and records the exit code', async () => {
    const server = await env.addServer();
    await start(server.id);
    await env.waitState(server.id, 'online');
    const res = await env.call<{ status: { state: string } }>('POST', `/api/servers/${server.id}/stop`);
    expect(res.status).toBe(200);
    expect(res.body.status.state).toBe('stopping');
    const status = await env.waitState(server.id, 'offline');
    expect(status.exitCode).toBe(0);
    expect(status.pid).toBeNull();
    expect(lineTexts(server.id).some((t) => t.endsWith('Saving worlds'))).toBe(true);
    await waitFor(async () => (await env.row(server.id))?.lastExitCode === 0 || undefined);
    expect(events.some((e) => e.type === 'server.crashed')).toBe(false);
  });

  it('answers SERVER_NOT_RUNNING for stop and kill on an offline server', async () => {
    const server = await env.addServer();
    for (const action of ['stop', 'kill']) {
      const res = await env.call<ErrorBody>('POST', `/api/servers/${server.id}/${action}`);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('SERVER_NOT_RUNNING');
    }
  });

  it('accepts bodyless POSTs even with a JSON content type', async () => {
    const server = await env.addServer();
    const res = await env.app.inject({ method: 'POST', url: `/api/servers/${server.id}/start`, headers: { 'content-type': 'application/json' } });
    expect(res.statusCode).toBe(200);
    await env.waitState(server.id, 'online');
    const stop = await env.app.inject({ method: 'POST', url: `/api/servers/${server.id}/stop`, headers: { 'content-type': 'application/json' } });
    expect(stop.statusCode).toBe(200);
  });

  it('escalates to a force kill after the stop timeout', async () => {
    await env.close();
    unsubscribe();
    await setup({ stopTimeoutMs: 400 });
    env.spawner.mode = 'ignore-stop';
    const server = await env.addServer();
    await start(server.id);
    await env.waitState(server.id, 'online');
    const t0 = Date.now();
    await env.call('POST', `/api/servers/${server.id}/stop`);
    const status = await env.waitState(server.id, 'offline', 10_000);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(350);
    expect(status.message).toBeNull();
    expect(lineTexts(server.id).some((t) => t.includes('being killed'))).toBe(true);
    expect(events.some((e) => e.type === 'server.crashed')).toBe(false);
  });

  it('kills immediately and counts it as expected', async () => {
    env.spawner.mode = 'ignore-stop';
    const server = await env.addServer();
    await start(server.id);
    await env.waitState(server.id, 'online');
    const pid = env.services.manager.status(server.id).pid as number;
    const res = await env.call('POST', `/api/servers/${server.id}/kill`);
    expect(res.status).toBe(200);
    await env.waitState(server.id, 'offline');
    expect(() => process.kill(pid, 0)).toThrow();
    expect(events.some((e) => e.type === 'server.crashed')).toBe(false);
  });
});

describe('crashes', () => {
  it('marks an unexpected exit as crashed with exit code and last lines', async () => {
    env.spawner.mode = 'crash';
    const server = await env.addServer();
    await start(server.id);
    const status = await env.waitState(server.id, 'crashed');
    expect(status.exitCode).toBe(1);
    expect(status.message).toContain('unexpectedly');
    expect(status.messageRef).toEqual({ key: 'SERVER_EXITED_UNEXPECTEDLY', params: { code: 1 } });
    const crash = events.find((e) => e.type === 'server.crashed');
    expect(crash).toMatchObject({ type: 'server.crashed', serverId: server.id, exitCode: 1 });
    expect(crash?.type === 'server.crashed' && crash.lastLines.some((l) => l.includes('Exception in server tick loop'))).toBe(true);
    // the refs run parallel to the lines: the exit message is a system line with a reference, the server's own output has none
    if (crash?.type !== 'server.crashed') throw new Error('no crash event');
    expect(crash.lastLinesRefs).toHaveLength(crash.lastLines.length);
    expect(crash.lastLinesRefs.at(-1)).toEqual({ key: 'SERVER_EXITED_UNEXPECTEDLY', params: { code: 1 } });
    expect(crash.lastLinesRefs[crash.lastLines.findIndex((l) => l.includes('Exception in server tick loop'))]).toBeNull();
    await waitFor(async () => (await env.row(server.id))?.lastExitCode === 1 || undefined);
    // a crashed server can be started again
    env.spawner.mode = 'normal';
    expect((await start(server.id)).status).toBe(200);
    await env.waitState(server.id, 'online');
  });

  it('marks an exit before the server became ready as crashed', async () => {
    env.spawner.mode = 'crash-early';
    const server = await env.addServer();
    await start(server.id);
    const status = await env.waitState(server.id, 'crashed');
    expect(status.exitCode).toBe(3);
  });

  it('turns a spawn error into a clear start failure and a crashed state', async () => {
    env.spawner.spawn = (request) => spawn(path.join(env.config.dataDir, 'does-not-exist.exe'), [], { cwd: request.cwd });
    const server = await env.addServer();
    const res = await env.call<ErrorBody>('POST', `/api/servers/${server.id}/start`);
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('START_FAILED');
    expect(res.body.error.message).toContain('Java');
    const status = env.services.manager.status(server.id);
    expect(status.state).toBe('crashed');
    expect(status.message).toContain('was not found');
    // not stuck: the guard sees it as not running
    expect(env.services.manager.isRunning(server.id)).toBe(false);
  });
});

describe('restart', () => {
  it('stops, then starts a fresh process', async () => {
    const server = await env.addServer();
    await start(server.id);
    await env.waitState(server.id, 'online');
    const firstPid = env.services.manager.status(server.id).pid;
    const res = await env.call<{ status: { state: string; pid: number } }>('POST', `/api/servers/${server.id}/restart`);
    expect(res.status).toBe(200);
    expect(res.body.status.pid).not.toBe(firstPid);
    await env.waitState(server.id, 'online');
    expect(env.spawner.calls).toHaveLength(2);
    expect(events.some((e) => e.type === 'server.crashed')).toBe(false);
  });

  it('just starts when the server is not running', async () => {
    const server = await env.addServer();
    const res = await env.call('POST', `/api/servers/${server.id}/restart`);
    expect(res.status).toBe(200);
  });
});

describe('guard, lock and mods', () => {
  it('blocks mod changes with SERVER_RUNNING end to end while the server runs', async () => {
    const server = await env.addServer({ loader: 'fabric' });
    env.modrinth.addProject('A', 'Alpha');
    env.modrinth.addVersion({ id: 'a1', projectId: 'A', number: '1', date: '2024-01-01T00:00:00Z' });
    await start(server.id);
    await env.waitState(server.id, 'starting');
    const blocked = await env.call<ErrorBody>('POST', `/api/servers/${server.id}/mods`, { projectId: 'A' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('SERVER_RUNNING');
    await env.waitState(server.id, 'online');
    expect((await env.call<ErrorBody>('POST', `/api/servers/${server.id}/mods`, { projectId: 'A' })).body.error.code).toBe('SERVER_RUNNING');
    await env.call('POST', `/api/servers/${server.id}/stop`);
    await env.waitState(server.id, 'offline');
    const ok = await env.call('POST', `/api/servers/${server.id}/mods`, { projectId: 'A' });
    expect(ok.status).toBe(201);
  });

  it('reports isRunning for starting, online and stopping, not for offline or crashed', async () => {
    const server = await env.addServer();
    const { manager } = env.services;
    expect(manager.isRunning(server.id)).toBe(false);
    await start(server.id);
    expect(manager.status(server.id).state).toBe('starting');
    expect(manager.isRunning(server.id)).toBe(true);
    await env.waitState(server.id, 'online');
    expect(manager.isRunning(server.id)).toBe(true);
    await manager.stop(server.id);
    expect(manager.status(server.id).state).toBe('stopping');
    expect(manager.isRunning(server.id)).toBe(true);
    await env.waitState(server.id, 'offline');
    expect(manager.isRunning(server.id)).toBe(false);
  });

  it('shares one lock: a start waits for a running mod operation on the same server', async () => {
    const server = await env.addServer();
    let release: () => void = () => undefined;
    const held = env.services.lock.run(server.id, () => new Promise<void>((resolve) => (release = resolve)));
    const starting = env.services.manager.start(server.id);
    await wait(250);
    expect(env.services.manager.status(server.id).state).toBe('offline');
    expect(env.spawner.calls).toHaveLength(0);
    release();
    await held;
    await starting;
    expect(env.services.manager.status(server.id).state).not.toBe('offline');
    // other servers are unaffected by that lock
    const other = await env.addServer();
    let releaseOther: () => void = () => undefined;
    const heldOther = env.services.lock.run(other.id, () => new Promise<void>((resolve) => (releaseOther = resolve)));
    const free = await env.addServer();
    expect((await start(free.id)).status).toBe(200);
    releaseOther();
    await heldOther;
  });
});

describe('background update check', () => {
  it('runs after the start for mod loaders, publishes the result and never blocks', async () => {
    const server = await env.addServer({ loader: 'fabric' });
    env.modrinth.addProject('A', 'Alpha');
    env.modrinth.addVersion({ id: 'a1', projectId: 'A', number: '1', date: '2024-01-01T00:00:00Z' });
    expect((await env.call('POST', `/api/servers/${server.id}/mods`, { projectId: 'A' })).status).toBe(201);
    env.modrinth.addVersion({ id: 'a2', projectId: 'A', number: '2', date: '2024-02-01T00:00:00Z' });
    await start(server.id);
    const event = await waitFor(() => events.find((e) => e.type === 'mods.updates'));
    expect(event).toMatchObject({ type: 'mods.updates', serverId: server.id, ok: true, count: 1, projects: ['Alpha'] });
  });

  it('is skipped for vanilla and a failing check does not fail the start', async () => {
    const vanilla = await env.addServer({ loader: 'vanilla' });
    await start(vanilla.id);
    await env.waitState(vanilla.id, 'online');
    const fabric = await env.addServer({ loader: 'fabric' });
    env.modrinth.addProject('A', 'Alpha');
    env.modrinth.addVersion({ id: 'a1', projectId: 'A', number: '1', date: '2024-01-01T00:00:00Z' });
    expect((await env.call('POST', `/api/servers/${fabric.id}/mods`, { projectId: 'A' })).status).toBe(201);
    env.modrinth.down = true;
    const res = await start(fabric.id);
    expect(res.status).toBe(200);
    const event = await waitFor(() => events.find((e) => e.type === 'mods.updates' && !e.ok), 10_000);
    expect(event).toMatchObject({ serverId: fabric.id, ok: false });
    expect(events.filter((e) => e.type === 'mods.updates' && e.serverId === vanilla.id)).toHaveLength(0);
  });
});

describe('shutdown', () => {
  it('stops every running server gracefully and does not report crashes', async () => {
    const a = await env.addServer();
    const b = await env.addServer();
    await start(a.id);
    await start(b.id);
    await env.waitState(a.id, 'online');
    await env.waitState(b.id, 'online');
    await env.services.manager.shutdown(8000);
    for (const id of [a.id, b.id]) {
      expect(env.services.manager.status(id).state).toBe('offline');
      expect(lineTexts(id).some((t) => t.endsWith('Saving worlds'))).toBe(true);
    }
    expect(events.some((e) => e.type === 'server.crashed')).toBe(false);
    expect(env.services.manager.metricsActive).toBe(false);
    await expect(env.services.manager.start(a.id)).rejects.toMatchObject({ code: 'SHUTTING_DOWN' });
  });

  it('force-kills servers that ignore stop once the bound is reached', async () => {
    env.spawner.mode = 'ignore-stop';
    const server = await env.addServer();
    await start(server.id);
    await env.waitState(server.id, 'online');
    const pid = env.services.manager.status(server.id).pid as number;
    await env.services.manager.shutdown(300);
    expect(env.services.manager.status(server.id).state).toBe('offline');
    expect(() => process.kill(pid, 0)).toThrow();
    expect(events.some((e) => e.type === 'server.crashed')).toBe(false);
  });

  it('counts an exit during shutdown as expected even when the process dies on its own', async () => {
    const server = await env.addServer();
    await start(server.id);
    await env.waitState(server.id, 'online');
    const shutdown = env.services.manager.shutdown(8000);
    // simulates the console Ctrl+C reaching the child at the same time
    await env.services.manager.sendCommand(server.id, 'exit 130').catch((error: unknown) => {
      expect(error).toBeInstanceOf(AppError);
    });
    await shutdown;
    expect(env.services.manager.status(server.id).state).toBe('offline');
  });
});

describe('metrics', () => {
  it('measures CPU and memory of a real process on this machine', async () => {
    await env.close();
    unsubscribe();
    await setup();
    env.spawner.mode = 'busy';
    const server = await env.addServer();
    await start(server.id);
    await env.waitState(server.id, 'online');
    const metrics = await waitFor(
      () => events.find((e) => e.type === 'server.metrics' && e.cpuPercent !== null && e.cpuPercent > 0 && e.rssBytes !== null),
      20_000,
      'Messwerte',
    );
    if (metrics.type !== 'server.metrics') throw new Error('unexpected event');
    expect(metrics.rssBytes).toBeGreaterThan(10 * 1024 * 1024);
    expect(metrics.cpuPercent).toBeGreaterThan(0);
    expect(metrics.cpuPercent).toBeLessThanOrEqual(100);
    expect(env.services.manager.status(server.id).rssBytes).toBeGreaterThan(0);
    await env.services.manager.kill(server.id);
    await env.waitState(server.id, 'offline');
    await waitFor(() => !env.services.manager.metricsActive || undefined);
  }, 40_000);
});
