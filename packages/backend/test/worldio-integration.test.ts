import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '../src/http/errors.js';
import { ServerEnv } from './server-env.js';

interface ErrorBody {
  error: { code: string };
}

let env: ServerEnv;
afterEach(async () => {
  await env.services.imports.idle();
  await env.services.exports.idle();
  await env.close();
});

const upload = (headers: Record<string, string> = {}) =>
  env.app.inject({ method: 'POST', url: '/api/imports', headers: { 'content-type': 'application/octet-stream', ...headers }, payload: Buffer.from('x') as Buffer });

describe('world import and export with login', () => {
  it('requires a login for every export and import route', async () => {
    env = await ServerEnv.create({ authToken: 'a-secret-token', allowedHosts: ['craft.local'] });
    const server = await env.addServer();
    for (const [method, url] of [
      ['POST', `/api/servers/${server.id}/exports`],
      ['POST', `/api/servers/${server.id}/backups/x/export`],
      ['GET', '/api/exports/x'],
      ['GET', '/api/exports/x/download'],
      ['DELETE', '/api/exports/x'],
      ['GET', '/api/imports/limits'],
      ['GET', '/api/imports/x'],
      ['DELETE', '/api/imports/x'],
      ['POST', '/api/imports/x/review'],
      ['POST', '/api/imports/x/create-server'],
      ['POST', `/api/servers/${server.id}/world/replace`],
    ] as const) {
      const res = await env.call<ErrorBody>(method, url);
      expect([res.status, res.body.error.code], `${method} ${url}`).toEqual([401, 'UNAUTHORIZED']);
    }
    const raw = await upload();
    expect([raw.statusCode, (JSON.parse(raw.body) as ErrorBody).error.code]).toEqual([401, 'UNAUTHORIZED']);
    // a foreign host is refused before anything is read
    const foreign = await upload({ host: 'evil.example' });
    expect(foreign.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe('world import and export during an update', () => {
  it('refuses new exports, uploads, imports and world replacement while an update is running', async () => {
    env = await ServerEnv.create();
    const server = await env.addServer();
    env.services.update.startGuard = () => new AppError(409, 'UPDATE_IN_PROGRESS', 'Update running.');
    for (const [method, url, body] of [
      ['POST', `/api/servers/${server.id}/exports`, {}],
      ['POST', `/api/servers/${server.id}/backups/x/export`, {}],
      ['POST', '/api/imports/x/create-server', { server: { name: 'x', loader: 'vanilla', mcVersion: '1.21.1' } }],
      ['POST', `/api/servers/${server.id}/world/replace`, { importId: 'x' }],
    ] as const) {
      const res = await env.call<ErrorBody>(method, url, body);
      expect([res.status, res.body.error.code], `${method} ${url}`).toEqual([409, 'UPDATE_IN_PROGRESS']);
    }
    const raw = await upload();
    expect([raw.statusCode, (JSON.parse(raw.body) as ErrorBody).error.code]).toEqual([409, 'UPDATE_IN_PROGRESS']);
  });

  it('does not report busy while nothing runs', async () => {
    env = await ServerEnv.create();
    expect(env.services.imports.busy).toBe(false);
    expect(env.services.exports.busy).toBe(false);
  });
});
