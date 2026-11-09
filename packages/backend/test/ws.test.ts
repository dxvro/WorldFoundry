import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_BUFFERED_BYTES, safeSend, type SendTarget } from '../src/http/ws.js';
import { ServerEnv, wait, waitFor } from './server-env.js';

type Json = Record<string, unknown> & { type: string };

class Client {
  readonly messages: Json[] = [];
  closeCode: number | null = null;
  readonly socket: WebSocket;

  constructor(url: string, headers: Record<string, string> = {}) {
    this.socket = new WebSocket(url, { headers } as never);
    this.socket.onmessage = (event) => this.messages.push(JSON.parse(String(event.data)) as Json);
    this.socket.onclose = (event) => {
      this.closeCode = event.code;
    };
  }

  async open(): Promise<this> {
    await new Promise<void>((resolve, reject) => {
      this.socket.onopen = () => resolve();
      this.socket.onerror = () => reject(new Error('Connection refused'));
    });
    return this;
  }

  send(message: unknown): void {
    this.socket.send(typeof message === 'string' ? message : JSON.stringify(message));
  }

  find(predicate: (message: Json) => boolean): Promise<Json> {
    return waitFor(() => this.messages.find(predicate), 8000, 'WebSocket message');
  }

  async close(): Promise<void> {
    if (this.closeCode !== null) return;
    this.socket.close();
    await waitFor(() => this.closeCode !== null || undefined);
  }
}

function rawUpgrade(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      agent: false,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        ...headers,
      },
    });
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve({ status: res.statusCode ?? 0 });
    });
    req.on('response', (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0 });
    });
    req.on('error', reject);
    req.end();
  });
}

let env: ServerEnv;
let port: number;
const url = (path: string): string => `ws://127.0.0.1:${port}${path}`;

async function startEnv(options: Parameters<typeof ServerEnv.create>[0] = {}): Promise<void> {
  env = await ServerEnv.create(options);
  await env.app.listen({ host: '127.0.0.1', port: 0 });
  port = (env.app.server.address() as { port: number }).port;
}

beforeEach(async () => {
  await startEnv();
});
afterEach(async () => {
  await env.close();
});

describe('console socket', () => {
  it('sends status and history on connect, then broadcasts lines and status changes', async () => {
    const server = await env.addServer();
    await env.services.manager.start(server.id);
    await env.waitState(server.id, 'online');

    const client = await new Client(url(`/api/servers/${server.id}/console`)).open();
    const status = await client.find((m) => m.type === 'status');
    expect(status['status']).toMatchObject({ state: 'online' });
    const history = await client.find((m) => m.type === 'history');
    const lines = history['lines'] as Array<{ text: string; stream: string }>;
    expect(lines.some((l) => l.text.includes('Done (1.234s)'))).toBe(true);
    // status arrives before the history, in the same tick the listener was added
    expect(client.messages.indexOf(status)).toBeLessThan(client.messages.indexOf(history));

    await env.services.manager.sendCommand(server.id, 'say Hello World');
    const live = await client.find((m) => m.type === 'line' && String((m['line'] as { text: string }).text).endsWith('[Server] Hello World'));
    expect(live['line']).toMatchObject({ stream: 'stdout' });

    await env.services.manager.stop(server.id);
    await client.find((m) => m.type === 'status' && (m['status'] as { state: string }).state === 'offline');
    await client.close();
  });

  it('runs commands from the client and acknowledges them', async () => {
    const server = await env.addServer();
    await env.services.manager.start(server.id);
    await env.waitState(server.id, 'online');
    const client = await new Client(url(`/api/servers/${server.id}/console`)).open();
    client.send({ type: 'command', command: 'say vom Client', id: 'c1' });
    await client.find((m) => m.type === 'ack' && m['id'] === 'c1');
    await client.find((m) => m.type === 'line' && String((m['line'] as { text: string }).text).endsWith('[Server] vom Client'));
    await client.close();
  });

  it('returns errors as messages and keeps the socket open', async () => {
    const server = await env.addServer();
    const client = await new Client(url(`/api/servers/${server.id}/console`)).open();

    client.send({ type: 'command', command: 'list', id: 'a' });
    const offline = await client.find((m) => m.type === 'error' && m['id'] === 'a');
    expect(offline['code']).toBe('SERVER_NOT_RUNNING');
    expect(String(offline['message'])).toContain('is not running');

    client.send('{broken');
    expect((await client.find((m) => m.type === 'error' && m['code'] === 'INVALID_MESSAGE'))['message']).toContain('JSON');
    client.send({ type: 'unknown' });
    client.send(JSON.stringify([1, 2]));
    client.send({ type: 'command' });
    client.socket.send(new Uint8Array([1, 2, 3]));
    await waitFor(() => client.messages.filter((m) => m.type === 'error' && m['code'] === 'INVALID_MESSAGE').length >= 5 || undefined);

    await env.services.manager.start(server.id);
    await env.waitState(server.id, 'online');
    client.send({ type: 'command', command: 'say hi\nstop', id: 'b' });
    const smuggle = await client.find((m) => m.type === 'error' && m['id'] === 'b');
    expect(smuggle['code']).toBe('INVALID_COMMAND');
    client.send({ type: 'ping' });
    await client.find((m) => m.type === 'pong');
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
    expect(env.services.manager.status(server.id).state).toBe('online');
    await client.close();
  });

  it('rejects unknown servers before the upgrade with a plain 404', async () => {
    expect((await rawUpgrade(port, '/api/servers/00000000-0000-4000-8000-000000000000/console')).status).toBe(404);
    await expect(new Client(url('/api/servers/nope/console')).open()).rejects.toThrow();
  });

  it('removes its listeners when the client closes, terminates or vanishes', async () => {
    const server = await env.addServer();
    const { manager } = env.services;
    expect(manager.listenerCount(server.id)).toBe(0);
    const clients: Client[] = [];
    for (let i = 0; i < 20; i++) clients.push(await new Client(url(`/api/servers/${server.id}/console`)).open());
    expect(manager.listenerCount(server.id)).toBe(20);
    for (const client of clients.slice(0, 10)) await client.close();
    await waitFor(() => manager.listenerCount(server.id) === 10 || undefined);
    // abrupt: the TCP connection is dropped without a close frame
    for (let i = 0; i < 10; i++) await rawUpgrade(port, `/api/servers/${server.id}/console`);
    await waitFor(() => manager.listenerCount(server.id) === 10 || undefined);
    // the remaining open clients are closed by the shutdown of the app
    await env.app.close();
    await waitFor(() => manager.listenerCount(server.id) === 0 || undefined);
    await Promise.all(clients.slice(10).map((client) => waitFor(() => client.closeCode !== null || undefined)));
    await startEnv();
  });

  it('does not leak listeners over many connect/close cycles', async () => {
    const server = await env.addServer();
    for (let i = 0; i < 40; i++) {
      const client = await new Client(url(`/api/servers/${server.id}/console`)).open();
      await client.close();
    }
    await waitFor(() => env.services.manager.listenerCount(server.id) === 0 || undefined);
    expect(env.services.bus.listenerCount).toBe(0);
  });
});

describe('events socket', () => {
  it('delivers a snapshot and then status, install and metric events', async () => {
    const client = await new Client(url('/api/events')).open();
    const snapshot = await client.find((m) => m.type === 'snapshot');
    expect(snapshot['servers']).toEqual([]);
    expect(env.services.bus.listenerCount).toBe(1);

    const server = await env.addServer();
    await env.services.manager.start(server.id);
    await client.find((m) => m.type === 'server.status' && (m['status'] as { state: string }).state === 'starting');
    await client.find((m) => m.type === 'server.status' && (m['status'] as { state: string }).state === 'online');
    await client.find((m) => m.type === 'server.metrics' && m['serverId'] === server.id);

    const created = await env.call<{ server: { id: string } }>('POST', '/api/servers', { name: 'New', loader: 'vanilla', mcVersion: '1.21.1' });
    await client.find((m) => m.type === 'install.state' && m['serverId'] === created.body.server.id && m['installState'] === 'installed');
    await client.find((m) => m.type === 'install.progress');
    await client.find((m) => m.type === 'server.changed' && m['reason'] === 'created');

    const late = await new Client(url('/api/events')).open();
    const lateSnapshot = await late.find((m) => m.type === 'snapshot');
    expect(JSON.stringify(lateSnapshot['servers'])).toContain(server.id);

    await client.close();
    await late.close();
    await waitFor(() => env.services.bus.listenerCount === 0 || undefined);
  });

  it('answers malformed messages with an error and pings with a pong', async () => {
    const client = await new Client(url('/api/events')).open();
    client.send('not json');
    await client.find((m) => m.type === 'error');
    client.send({ type: 'ping' });
    await client.find((m) => m.type === 'pong');
    await client.close();
  });
});

describe('slow clients', () => {
  const fake = (bufferedAmount: number, readyState = 1): { target: SendTarget; sent: string[]; closed: Array<[number | undefined, string | undefined]> } => {
    const sent: string[] = [];
    const closed: Array<[number | undefined, string | undefined]> = [];
    const target = {
      readyState,
      bufferedAmount,
      send: (data: string) => void sent.push(data),
      close: (code?: number, reason?: string) => void closed.push([code, reason]),
    } as unknown as SendTarget;
    return { target, sent, closed };
  };

  it('sends normally while the buffer is small', () => {
    const { target, sent } = fake(100);
    expect(safeSend(target, { a: 1 })).toBe(true);
    expect(sent).toEqual(['{"a":1}']);
  });

  it('drops the message and closes the client once too much data is queued', () => {
    const { target, sent, closed } = fake(MAX_BUFFERED_BYTES + 1);
    expect(safeSend(target, { a: 1 })).toBe(false);
    expect(sent).toEqual([]);
    expect(closed).toEqual([[1013, 'Client too slow']]);
  });

  it('ignores sockets that are not open', () => {
    const { target, sent, closed } = fake(0, 3);
    expect(safeSend(target, { a: 1 })).toBe(false);
    expect(sent).toEqual([]);
    expect(closed).toEqual([]);
  });

  it('survives a send that throws', () => {
    const { target } = fake(0);
    (target as unknown as { send: () => void }).send = () => {
      throw new Error('broken');
    };
    expect(safeSend(target, { a: 1 })).toBe(false);
  });
});

describe('origin and authentication on upgrades', () => {
  it('rejects foreign origins for console and events with 403 and accepts matching ones', async () => {
    const server = await env.addServer();
    for (const path of [`/api/servers/${server.id}/console`, '/api/events']) {
      expect((await rawUpgrade(port, path, { Origin: 'http://evil.example' })).status, path).toBe(403);
      expect((await rawUpgrade(port, path, { Origin: 'null' })).status, path).toBe(403);
      expect((await rawUpgrade(port, path, { Origin: `http://127.0.0.1:${port}` })).status, path).toBe(101);
      expect((await rawUpgrade(port, path)).status, path).toBe(101);
    }
    await expect(new Client(url('/api/events'), { Origin: 'http://evil.example' }).open()).rejects.toThrow();
    const ok = await new Client(url('/api/events'), { Origin: `http://127.0.0.1:${port}` }).open();
    await ok.close();
  });

  it('honours the ALLOWED_ORIGINS allowlist for sockets', async () => {
    await env.close();
    await startEnv({ allowedOrigins: ['http://localhost:5173'] });
    expect((await rawUpgrade(port, '/api/events', { Origin: 'http://localhost:5173' })).status).toBe(101);
    expect((await rawUpgrade(port, '/api/events', { Origin: 'http://localhost:5174' })).status).toBe(403);
  });

  it('requires authentication for sockets when AUTH_TOKEN is set (cookie or bearer)', async () => {
    await env.close();
    await startEnv({ authToken: 'a-secret-token' });
    const server = await env.addServer();
    const path = `/api/servers/${server.id}/console`;
    expect((await rawUpgrade(port, path)).status).toBe(401);
    expect((await rawUpgrade(port, '/api/events')).status).toBe(401);
    expect((await rawUpgrade(port, path, { Authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await rawUpgrade(port, path, { Authorization: 'Bearer a-secret-token' })).status).toBe(101);

    const login = await env.call('POST', '/api/auth/login', { token: 'a-secret-token' });
    const cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
    expect((await rawUpgrade(port, '/api/events', { Cookie: cookie })).status).toBe(101);
    const client = await new Client(url(path), { Cookie: cookie }).open();
    await client.find((m) => m.type === 'status');
    await client.close();
    await expect(new Client(url(path)).open()).rejects.toThrow();
  });
});

describe('server shutdown with open sockets', () => {
  it('closes connected clients when the app closes', async () => {
    const client = await new Client(url('/api/events')).open();
    await client.find((m) => m.type === 'snapshot');
    await env.app.close();
    await waitFor(() => client.closeCode !== null || undefined);
    await wait(10);
    await startEnv();
  });
});

describe('console socket input validation', () => {
  it('answers a bad history query with a plain HTTP 400 instead of upgrading', async () => {
    const server = await env.addServer();
    const base = `/api/servers/${server.id}/console`;
    for (const query of ['?history=abc', '?history=-1', '?history=2001', '?history=1.5']) {
      expect((await rawUpgrade(port, `${base}${query}`)).status, query).toBe(400);
    }
    await expect(new Client(url(`${base}?history=abc`)).open()).rejects.toThrow();
    expect((await rawUpgrade(port, `${base}?history=5`)).status).toBe(101);
    expect((await rawUpgrade(port, base)).status).toBe(101);
    expect((await rawUpgrade(port, '/api/servers/unknown/console?history=abc')).status).toBe(400);
    expect((await rawUpgrade(port, '/api/servers/unknown/console')).status).toBe(404);
  });

  it('keeps the process alive and serving after bad upgrade requests', async () => {
    const server = await env.addServer();
    const uncaught: unknown[] = [];
    const record = (error: unknown): void => {
      uncaught.push(error);
    };
    process.on('uncaughtException', record);
    try {
      await rawUpgrade(port, `/api/servers/${server.id}/console?history=abc`);
      await wait(50);
    } finally {
      process.off('uncaughtException', record);
    }
    expect(uncaught).toEqual([]);
    expect((await env.call('GET', '/api/health')).status).toBe(200);
  });
});

describe('upgrades with encoded paths and host checks', () => {
  it('requires authentication for percent-encoded socket paths', async () => {
    await env.close();
    await startEnv({ authToken: 'a-secret-token' });
    const server = await env.addServer();
    const bearer = { Authorization: 'Bearer a-secret-token' };
    for (const path of ['/%61pi/events', '/api/%65vents', `/%61pi/servers/${server.id}/console`, `/api/servers/${server.id}/%63onsole`]) {
      expect((await rawUpgrade(port, path)).status, path).toBe(401);
      expect((await rawUpgrade(port, path, bearer)).status, path).toBe(101);
    }
  });

  it('rejects a foreign Host on upgrades with 403, also with a matching Origin', async () => {
    const server = await env.addServer();
    for (const path of ['/api/events', `/api/servers/${server.id}/console`]) {
      expect((await rawUpgrade(port, path, { Host: 'evil.example', Origin: 'http://evil.example' })).status, path).toBe(403);
      expect((await rawUpgrade(port, path, { Host: 'evil.example:3000' })).status, path).toBe(403);
      expect((await rawUpgrade(port, path, { Host: `localhost:${port}` })).status, path).toBe(101);
    }
  });
});
