import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config/env.js';
import { servers } from '../src/db/schema.js';
import { Auth, registerAuth } from '../src/http/auth.js';
import { errorHandler, notFoundHandler } from '../src/http/errors.js';
import { isHostAllowed, parseHostHeader } from '../src/http/host.js';
import { ServerEnv } from './server-env.js';

interface ErrorBody {
  error: { code: string; message: string };
}

const TOKEN = 'a-secret-token';

// light-my-request normalises paths, so these probes go over a real socket with the path untouched
function rawGet(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, agent: false, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('authentication is decided on the matched route', () => {
  let env: ServerEnv;
  let port: number;
  beforeEach(async () => {
    env = await ServerEnv.create({ authToken: TOKEN });
    await env.app.listen({ host: '127.0.0.1', port: 0 });
    port = (env.app.server.address() as { port: number }).port;
  });
  afterEach(async () => {
    await env.close();
  });

  it('rejects percent-encoded spellings of protected routes', async () => {
    const server = await env.addServer();
    for (const path of [
      '/%61pi/servers',
      '/api/%73ervers',
      '/%61pi/system',
      '/%61pi/%73ervers',
      `/%61pi/servers/${server.id}`,
      `/api/servers/%${server.id.charCodeAt(0).toString(16)}${server.id.slice(1)}`,
      '/%61pi/events',
      '/%2561pi/servers',
      '/api/servers?x=/api/health',
    ]) {
      const res = await rawGet(port, path);
      expect([path, res.status === 401 || res.status === 404]).toEqual([path, true]);
      expect(res.body, path).not.toContain('"servers"');
      expect(res.body, path).not.toContain(server.id);
    }
    expect((await rawGet(port, '/%61pi/servers')).status).toBe(401);
    expect((await rawGet(port, '/api/%73ervers')).status).toBe(401);
    expect((await rawGet(port, '/%61pi/system')).status).toBe(401);
  });

  it('rejects double slashes, trailing slashes and dot segments around public and protected routes', async () => {
    for (const path of [
      '//api/servers',
      '/api//servers',
      '/api/servers/',
      '/api/health/../servers',
      '/api/health/%2e%2e/servers',
      '/api/auth/status/../../servers',
      '/api/health/',
      '/api/auth/login/',
      '/API/servers',
    ]) {
      const res = await rawGet(port, path);
      expect(res.status === 401 || res.status === 404, `${path} -> ${res.status}`).toBe(true);
      expect(res.body, path).not.toContain('lanUrls');
      expect(res.body, path).not.toMatch(/"servers"\s*:\s*\[/);
    }
    for (const path of ['//api/servers', '/api//servers', '/api/servers/', '/api/health/../servers', '/api/health/']) {
      expect((await rawGet(port, path)).status, path).toBe(401);
    }
  });

  it('keeps public routes public under encoding, but with the minimal body', async () => {
    for (const path of ['/api/health', '/%61pi/health', '/api/%68ealth', '/api/auth/status', '/%61pi/auth/status']) {
      const res = await rawGet(port, path);
      expect([path, res.status]).toEqual([path, 200]);
      expect(res.body, path).not.toContain('lanUrls');
    }
    expect(JSON.parse((await rawGet(port, '/%61pi/health')).body)).toEqual({ status: 'ok', database: 'ok' });
  });

  it('serves protected routes under encoding to a logged-in client', async () => {
    const authorization = `Bearer ${TOKEN}`;
    expect((await rawGet(port, '/%61pi/servers', { authorization })).status).toBe(200);
    expect((await rawGet(port, '/api/%73ervers', { authorization })).status).toBe(200);
  });

  it('answers unmatched paths outside the API with a 404 that reveals nothing', async () => {
    const res = await rawGet(port, '/anything');
    expect(res.status).toBe(404);
    expect((JSON.parse(res.body) as ErrorBody).error.code).toBe('NOT_FOUND');
    expect((await rawGet(port, '/')).status).toBe(404);
  });
});

describe('default-deny outside /api', () => {
  const build = () => {
    const app = Fastify();
    app.setErrorHandler(errorHandler);
    app.setNotFoundHandler(notFoundHandler);
    registerAuth(app, new Auth({ token: TOKEN, failureDelayMs: 0 }));
    app.get('/secret', async () => ({ secret: true }));
    app.get('/api/data', async () => ({ data: true }));
    app.get('/', async () => ({ page: 'index' }));
    app.get('/*', async () => ({ page: 'static' }));
    return app;
  };

  it('requires a login for every matched route that is not explicitly public', async () => {
    const app = build();
    for (const url of ['/secret', '/%73ecret', '/api/data', '/%61pi/data', '/api/dat%61']) {
      const res = await app.inject({ method: 'GET', url });
      expect([url, res.statusCode]).toEqual([url, 401]);
    }
    const ok = await app.inject({ method: 'GET', url: '/%73ecret', headers: { authorization: `Bearer ${TOKEN}` } });
    expect(ok.json()).toEqual({ secret: true });
    await app.close();
  });

  it('keeps the explicit static allowance by route pattern, which encoding cannot reach into /api', async () => {
    const app = build();
    expect((await app.inject({ method: 'GET', url: '/' })).json()).toEqual({ page: 'index' });
    expect((await app.inject({ method: 'GET', url: '/assets/app.js' })).json()).toEqual({ page: 'static' });
    expect((await app.inject({ method: 'GET', url: '/%61pi/data' })).statusCode).toBe(401);
    await app.close();
  });
});

describe('host header allowlist', () => {
  const machine = os.hostname();
  let env: ServerEnv;
  beforeEach(async () => {
    env = await ServerEnv.create({ allowedHosts: ['craft.example.lan'] });
  });
  afterEach(async () => {
    await env.close();
  });

  const get = (host: string, extra: Record<string, string> = {}) => env.app.inject({ method: 'GET', url: '/api/servers', headers: { host, ...extra } });

  it('accepts IP literals, localhost, this machine and ALLOWED_HOSTS entries', async () => {
    const hosts = [
      'localhost',
      'LOCALHOST:5173',
      'app.localhost:3000',
      '127.0.0.1',
      '192.168.178.5:3000',
      '[::1]:3000',
      '[fe80::1]',
      '[2001:db8::7]:8080',
      machine,
      machine.toUpperCase(),
      `${machine}:3000`,
      ...['.local', '.lan', '.home', '.home.arpa', '.fritz.box'].flatMap((suffix) => [`${machine}${suffix}`, `${machine.toUpperCase()}${suffix}:3000`]),
      'craft.example.lan',
      'Craft.Example.LAN:3000',
    ];
    for (const host of hosts) {
      const res = await get(host);
      expect([host, res.statusCode]).toEqual([host, 200]);
    }
  });

  it('rejects a DNS-rebinding host on GET, POST and with a matching Origin', async () => {
    const before = await env.t.db.select().from(servers);
    for (const host of ['evil.example', 'evil.example:3000', 'localhost.evil.example', 'x.localhost.evil.example', `${machine}.evil.example`, `${machine}x`]) {
      const res = await get(host, { origin: `http://${host}` });
      expect([host, res.statusCode, res.json<ErrorBody>().error.code]).toEqual([host, 403, 'HOST_FORBIDDEN']);
      const post = await env.app.inject({
        method: 'POST',
        url: '/api/servers',
        headers: { host, origin: `http://${host}`, 'content-type': 'application/json' },
        payload: { name: 'X', loader: 'vanilla', mcVersion: '1.21.1' },
      });
      expect([host, post.statusCode]).toEqual([host, 403]);
    }
    expect(await env.t.db.select().from(servers)).toHaveLength(before.length);
    expect(env.spawner.calls).toHaveLength(0);
  });

  it('rejects malformed hosts', async () => {
    for (const host of ['user@localhost', 'localhost/', 'local host', '[::1', 'a:b', 'localhost:99999x', '127.0.0.1.evil.example', '[evil]:80', '-bad.localhost']) {
      expect([host, (await get(host)).statusCode]).toEqual([host, 403]);
    }
  });

  it('rejects a missing Host header on a listening server', async () => {
    await env.app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = env.app.server.address() as net.AddressInfo;
    const response = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => socket.write('GET /api/health HTTP/1.0\r\n\r\n'));
      let data = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => (data += chunk));
      socket.on('end', () => resolve(data));
      socket.on('error', reject);
    });
    expect(response).toMatch(/^HTTP\/1\.1 403 /);
    expect(response).toContain('HOST_FORBIDDEN');
  });

  it('unit: parseHostHeader and isHostAllowed', () => {
    expect(parseHostHeader('Example.COM:80')).toBe('example.com');
    expect(parseHostHeader('[::1]:80')).toBe('::1');
    expect(parseHostHeader('localhost.')).toBe('localhost');
    expect(parseHostHeader('a:b:c')).toBeNull();
    expect(parseHostHeader('')).toBeNull();
    expect(isHostAllowed(undefined, [], 'pc')).toBe(false);
    expect(isHostAllowed('PC.Fritz.Box', [], 'pc')).toBe(true);
    expect(isHostAllowed('pc.example', [], 'pc')).toBe(false);
    expect(isHostAllowed('other', ['other'], 'pc')).toBe(true);
  });
});

describe('ALLOWED_HOSTS configuration', () => {
  it('parses a comma separated list into lowercase host names', () => {
    expect(loadConfig({}).allowedHosts).toEqual([]);
    expect(loadConfig({ ALLOWED_HOSTS: 'Craft.Example.lan, mc.home:3000 ,' }).allowedHosts).toEqual(['craft.example.lan', 'mc.home']);
  });

  it('rejects invalid entries with a readable error', () => {
    expect(() => loadConfig({ ALLOWED_HOSTS: 'http://evil.example' })).toThrow(ConfigError);
    expect(() => loadConfig({ ALLOWED_HOSTS: 'a b' })).toThrow(/ALLOWED_HOSTS/);
  });
});
