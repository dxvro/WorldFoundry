import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { servers } from '../src/db/schema.js';
import { noRunningServers } from '../src/mods/runtime-guard.js';
import { FakeModrinth } from './fake-modrinth.js';
import { createTestDb, serverRow, testConfig, type TestDb } from './helpers.js';

let t: TestDb;
let app: FastifyInstance;
beforeEach(async () => {
  t = await createTestDb();
  app = buildApp({
    db: t.db,
    config: testConfig(t.dir),
    modrinth: new FakeModrinth().api(),
    runtimeGuard: noRunningServers,
    javaStandardRoots: [],
  });
});
afterEach(async () => {
  await app.close();
  await t.cleanup();
});

describe('HTTP', () => {
  it('GET /api/health returns the ok shape', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string; version: string; uptimeSeconds: number; database: string; lanUrls: string[] }>();
    expect(body.status).toBe('ok');
    expect(body.database).toBe('ok');
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(body.lanUrls)).toBe(true);
    for (const url of body.lanUrls) expect(url).toMatch(/^http:\/\/(\d+\.\d+\.\d+\.\d+|localhost):3999$/);
  });

  it('GET /api/health returns 503 with the error shape when the database fails', async () => {
    t.close();
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      error: { code: 'DATABASE_UNAVAILABLE', message: 'The database is not reachable.' },
    });
  });

  it('GET /api/servers returns an empty list', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/servers' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ servers: [] });
  });

  it('GET /api/servers returns stored servers', async () => {
    await t.db.insert(servers).values(serverRow('s1'));
    const res = await app.inject({ method: 'GET', url: '/api/servers' });
    const body = res.json<{ servers: { id: string; port: number; installState: string }[] }>();
    expect(body.servers).toHaveLength(1);
    expect(body.servers[0]).toMatchObject({ id: 's1', port: 25565, installState: 'pending' });
  });

  it('unknown routes yield the 404 shape', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/does-not-exist' });
    expect(res.statusCode).toBe(404);
    const body = res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toContain('was not found');
  });

  it('unexpected errors yield a 500 without leaking internals', async () => {
    app.get('/api/boom', async () => {
      throw new Error('secret password in /etc/secret');
    });
    const res = await app.inject({ method: 'GET', url: '/api/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'An internal error occurred.' },
    });
    expect(res.body).not.toContain('secret password');
    expect(res.body).not.toContain('stack');
  });
});
