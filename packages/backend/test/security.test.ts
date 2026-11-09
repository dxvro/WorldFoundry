import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config/env.js';
import { servers } from '../src/db/schema.js';
import { Auth, LoginLimiter, parseCookies } from '../src/http/auth.js';
import { isOriginAllowed } from '../src/http/origin.js';
import { ServerEnv } from './server-env.js';

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

describe('origin check', () => {
  let env: ServerEnv;
  beforeEach(async () => {
    env = await ServerEnv.create({ allowedOrigins: ['http://localhost:5173'], allowedHosts: ['craft.local'] });
  });
  afterEach(async () => {
    await env.close();
  });

  const post = (origin: string | undefined, host = 'craft.local:3000') =>
    env.app.inject({
      method: 'POST',
      url: '/api/servers',
      headers: { host, ...(origin === undefined ? {} : { origin }), 'content-type': 'application/json' },
      payload: { name: 'X', loader: 'vanilla', mcVersion: '1.21.1' },
    });

  it('rejects state-changing requests from a foreign origin with 403 ORIGIN_FORBIDDEN and does nothing', async () => {
    for (const origin of ['http://evil.example', 'http://craft.local:3001', 'http://craft.local', 'null', 'garbage']) {
      const res = await post(origin);
      expect(res.statusCode, origin).toBe(403);
      expect(res.json<ErrorBody>().error.code).toBe('ORIGIN_FORBIDDEN');
    }
    expect(await env.t.db.select().from(servers)).toHaveLength(0);
  });

  it('guards PATCH, DELETE and the action routes too', async () => {
    const server = await env.addServer();
    for (const [method, url] of [
      ['PATCH', `/api/servers/${server.id}`],
      ['DELETE', `/api/servers/${server.id}?confirm=true`],
      ['POST', `/api/servers/${server.id}/start`],
      ['POST', `/api/servers/${server.id}/command`],
      ['PATCH', `/api/servers/${server.id}/properties`],
      ['POST', `/api/servers/${server.id}/mods/scan`],
    ] as const) {
      const res = await env.app.inject({ method, url, headers: { origin: 'http://evil.example', host: 'craft.local:3000' } });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    expect(env.spawner.calls).toHaveLength(0);
    expect(await env.row(server.id)).toBeDefined();
  });

  it('accepts a matching Origin, a missing Origin and allowlisted origins', async () => {
    expect((await post('http://craft.local:3000')).statusCode).toBe(201);
    expect((await post('http://CRAFT.local:3000')).statusCode).toBe(201);
    expect((await post(undefined)).statusCode).toBe(201);
    expect((await post('http://localhost:5173')).statusCode).toBe(201);
    expect((await post('http://localhost:5174')).statusCode).toBe(403);
    await env.services.install.idle();
  });

  it('does not restrict reads', async () => {
    const res = await env.app.inject({ method: 'GET', url: '/api/servers', headers: { origin: 'http://evil.example', host: 'craft.local:3000' } });
    expect(res.statusCode).toBe(200);
  });

  it('unit: isOriginAllowed compares host and port or the allowlist', () => {
    expect(isOriginAllowed('http://a:1', 'a:1', [])).toBe(true);
    expect(isOriginAllowed('http://a:1', 'b:1', [])).toBe(false);
    expect(isOriginAllowed('http://a:1', undefined, [])).toBe(false);
    expect(isOriginAllowed('http://v:5173', 'a:1', ['http://v:5173'])).toBe(true);
  });
});

describe('configuration', () => {
  it('parses AUTH_TOKEN, ALLOWED_ORIGINS and STOP_TIMEOUT_SECONDS', () => {
    const config = loadConfig({ AUTH_TOKEN: 'secret-12345', ALLOWED_ORIGINS: 'http://localhost:5173, http://127.0.0.1:5173/', STOP_TIMEOUT_SECONDS: '90' });
    expect(config.authToken).toBe('secret-12345');
    expect(config.allowedOrigins).toEqual(['http://localhost:5173', 'http://127.0.0.1:5173']);
    expect(config.stopTimeoutMs).toBe(90_000);
    const defaults = loadConfig({});
    expect(defaults.authToken).toBeUndefined();
    expect(defaults.allowedOrigins).toEqual([]);
    expect(defaults.stopTimeoutMs).toBe(120_000);
    expect(loadConfig({ AUTH_TOKEN: '' }).authToken).toBeUndefined();
  });

  it('rejects too short tokens and invalid origins with readable errors', () => {
    expect(() => loadConfig({ AUTH_TOKEN: 'short' })).toThrow(ConfigError);
    expect(() => loadConfig({ AUTH_TOKEN: 'short' })).toThrow(/AUTH_TOKEN/);
    expect(() => loadConfig({ ALLOWED_ORIGINS: 'not-a-url' })).toThrow(/ALLOWED_ORIGINS/);
    expect(() => loadConfig({ STOP_TIMEOUT_SECONDS: '1' })).toThrow(/STOP_TIMEOUT_SECONDS/);
  });
});

describe('authentication disabled', () => {
  let env: ServerEnv;
  beforeEach(async () => {
    env = await ServerEnv.create();
  });
  afterEach(async () => {
    await env.close();
  });

  it('serves everything and reports that no login is required', async () => {
    expect((await env.call('GET', '/api/servers')).status).toBe(200);
    expect((await env.call('GET', '/api/auth/status')).body).toEqual({ authRequired: false, authenticated: true, credential: 'none' });
    const health = await env.call<Record<string, unknown>>('GET', '/api/health');
    expect(health.body).toHaveProperty('lanUrls');
    expect(health.body).toHaveProperty('version');
    const login = await env.call('POST', '/api/auth/login', { token: 'whatever' });
    expect(login.status).toBe(200);
    expect(login.headers['set-cookie']).toBeUndefined();
  });
});

describe('authentication enabled', () => {
  const TOKEN = 'a-secret-token';
  let env: ServerEnv;
  beforeEach(async () => {
    env = await ServerEnv.create({ authToken: TOKEN, allowedHosts: ['craft.local'] });
  });
  afterEach(async () => {
    await env.close();
  });

  const cookieOf = (headers: Record<string, unknown>): string => String(headers['set-cookie']).split(';')[0] ?? '';

  it('protects every /api route except health, login and status', async () => {
    const server = await env.addServer();
    for (const [method, url] of [
      ['GET', '/api/servers'],
      ['GET', `/api/servers/${server.id}`],
      ['POST', `/api/servers/${server.id}/start`],
      ['GET', '/api/system'],
      ['GET', '/api/loaders'],
      ['GET', `/api/servers/${server.id}/mods`],
      ['GET', '/api/modrinth/categories'],
      ['GET', '/api/does-not-exist'],
    ] as const) {
      const res = await env.call<ErrorBody>(method, url);
      expect([res.status, res.body.error.code], `${method} ${url}`).toEqual([401, 'UNAUTHORIZED']);
    }
    expect(env.spawner.calls).toHaveLength(0);
    expect((await env.call('GET', '/api/auth/status')).body).toEqual({ authRequired: true, authenticated: false, credential: 'token' });
    expect((await env.call('GET', '/api/health')).status).toBe(200);
  });

  it('keeps /api/health minimal without login, full with login', async () => {
    const anon = await env.call<Record<string, unknown>>('GET', '/api/health');
    expect(anon.body).toEqual({ status: 'ok', database: 'ok' });
    const full = await env.call<Record<string, unknown>>('GET', '/api/health', undefined, { authorization: `Bearer ${TOKEN}` });
    expect(full.body).toHaveProperty('lanUrls');
    expect(full.body).toHaveProperty('version');
  });

  it('accepts a Bearer token and rejects wrong, empty and malformed ones', async () => {
    expect((await env.call('GET', '/api/servers', undefined, { authorization: `Bearer ${TOKEN}` })).status).toBe(200);
    expect((await env.call('GET', '/api/servers', undefined, { authorization: `bearer ${TOKEN}` })).status).toBe(200);
    for (const header of ['Bearer wrong', 'Bearer ', TOKEN, `Basic ${TOKEN}`, `Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(0, -1)}`]) {
      expect((await env.call('GET', '/api/servers', undefined, { authorization: header })).status, header).toBe(401);
    }
  });

  it('login sets an HttpOnly SameSite=Strict cookie that authenticates, logout clears it', async () => {
    const login = await env.call('POST', '/api/auth/login', { token: TOKEN });
    expect(login.status).toBe(200);
    const setCookie = String(login.headers['set-cookie']);
    expect(setCookie).toMatch(/^cm_session=[0-9a-f]{64};/);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).not.toContain(TOKEN);

    const cookie = cookieOf(login.headers);
    expect((await env.call('GET', '/api/servers', undefined, { cookie })).status).toBe(200);
    expect((await env.call('GET', '/api/auth/status', undefined, { cookie })).body).toEqual({ authRequired: true, authenticated: true, credential: 'token' });
    expect((await env.call('GET', '/api/servers', undefined, { cookie: 'cm_session=abc' })).status).toBe(401);
    expect((await env.call('GET', '/api/servers', undefined, { cookie: `other=1; ${cookie}; x=2` })).status).toBe(200);

    const logout = await env.call('POST', '/api/auth/logout', undefined, { cookie });
    expect(logout.status).toBe(200);
    expect(String(logout.headers['set-cookie'])).toContain('Max-Age=0');
    expect(String(logout.headers['set-cookie'])).toContain('HttpOnly');
  });

  it('answers a wrong login with 401 INVALID_TOKEN and blocks the IP after repeated failures', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await env.call<ErrorBody>('POST', '/api/auth/login', { token: `wrong-${i}` });
      expect([res.status, res.body.error.code]).toEqual([401, 'INVALID_TOKEN']);
      expect(res.headers['set-cookie']).toBeUndefined();
    }
    const blocked = await env.call<ErrorBody>('POST', '/api/auth/login', { token: TOKEN });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('TOO_MANY_ATTEMPTS');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(blocked.headers['set-cookie']).toBeUndefined();
    // bearer access is not affected by the login limiter
    expect((await env.call('GET', '/api/servers', undefined, { authorization: `Bearer ${TOKEN}` })).status).toBe(200);
  });

  it('rejects a login without body or token with 400', async () => {
    expect((await env.call('POST', '/api/auth/login', {})).status).toBe(400);
    expect((await env.app.inject({ method: 'POST', url: '/api/auth/login' })).statusCode).toBe(400);
  });

  it('also enforces the origin check on login', async () => {
    const res = await env.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: 'http://evil.example', host: 'craft.local:3000', 'content-type': 'application/json' },
      payload: { token: TOKEN },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('auth primitives', () => {
  it('limiter blocks after the maximum, expires with the window and resets on success', () => {
    let now = 0;
    const limiter = new LoginLimiter({ maxFailures: 3, windowMs: 1000, now: () => now });
    for (let i = 0; i < 2; i++) limiter.recordFailure('ip');
    expect(limiter.retryAfterSeconds('ip')).toBe(0);
    limiter.recordFailure('ip');
    expect(limiter.retryAfterSeconds('ip')).toBe(1);
    expect(limiter.retryAfterSeconds('other')).toBe(0);
    now = 1001;
    expect(limiter.retryAfterSeconds('ip')).toBe(0);
    limiter.recordFailure('ip');
    limiter.reset('ip');
    expect(limiter.retryAfterSeconds('ip')).toBe(0);
  });

  it('compares tokens of any length without throwing', () => {
    const auth = new Auth({ token: 'abcdefgh' });
    expect(auth.verifyToken('abcdefgh')).toBe(true);
    for (const bad of ['', 'abcdefg', 'abcdefghi', 'x'.repeat(10_000), 'ABCDEFGH']) expect(auth.verifyToken(bad)).toBe(false);
    expect(new Auth({ token: undefined }).verifyToken('abcdefgh')).toBe(false);
  });

  it('parses cookie headers defensively', () => {
    expect(parseCookies('a=1; b=2;c=%20x; bad; =x; q="v w"')).toEqual({ a: '1', b: '2', c: ' x', q: 'v w' });
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies('a=%E0%A4%A')).toEqual({ a: '%E0%A4%A' });
  });
});
