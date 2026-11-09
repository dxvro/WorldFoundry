import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppEvent } from '../src/events/bus.js';
import type { SystemUpdateState } from '../src/update/types.js';
import { buildRelease, FakeGithub, makeKeys } from './fake-github.js';
import { ServerEnv } from './server-env.js';

interface ErrorBody {
  error: { code: string; message: string };
}

const TOKEN = 'secret-12345';
const auth = { Authorization: `Bearer ${TOKEN}` };

let env: ServerEnv;
let github: FakeGithub;
let events: AppEvent[];

beforeEach(async () => {
  github = new FakeGithub();
  const keys = makeKeys();
  github.add(buildRelease({ version: '0.2.0', keys, notes: '## New\n- Update feature' }));
  env = await ServerEnv.create({
    authToken: TOKEN,
    config: { updateCheck: true, updateRepo: 'owner/repo' },
    update: { currentVersion: '0.1.0', fetch: github.fetch as typeof fetch, keys: [{ id: 't', publicKey: keys.publicPem }], platform: 'linux', arch: 'x64', timings: { bootDelayMs: 3_600_000 } },
  });
  events = [];
  env.services.bus.subscribe((event) => events.push(event));
});
afterEach(async () => {
  await env.close();
});

describe('/api/system/update', () => {
  it('needs a login like every other route', async () => {
    for (const [method, url] of [
      ['GET', '/api/system/update'],
      ['POST', '/api/system/update/check'],
      ['POST', '/api/system/update/apply'],
      ['POST', '/api/system/update/cancel'],
      ['PATCH', '/api/system/update/settings'],
    ] as const) {
      const res = await env.call<ErrorBody>(method, url, method === 'GET' ? undefined : {});
      expect(res.status, `${method} ${url}`).toBe(401);
    }
    expect(github.requests).toEqual([]);
  });

  it('delivers the state, checks on request and announces the change as an event', async () => {
    const first = await env.call<SystemUpdateState>('GET', '/api/system/update', undefined, auth);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ currentVersion: '0.1.0', installMode: 'dev', checksEnabled: true, autoCheck: true, channel: 'stable', repo: 'owner/repo', phase: 'idle', latest: null, history: [] });
    expect(first.body.installModeNote).toContain('source code');

    const checked = await env.call<SystemUpdateState>('POST', '/api/system/update/check', undefined, auth);
    expect(checked.status).toBe(200);
    expect(checked.body).toMatchObject({ updateAvailable: true, canApply: false });
    expect(checked.body.latest).toMatchObject({ version: '0.2.0', notes: '## New\n- Update feature' });
    expect(events.some((event) => event.type === 'update.state' && event.state.latest?.version === '0.2.0')).toBe(true);
  });

  it('refuses to apply without confirmation, and in a checkout at all', async () => {
    await env.call('POST', '/api/system/update/check', undefined, auth);
    const unconfirmed = await env.call<ErrorBody>('POST', '/api/system/update/apply', {}, auth);
    expect(unconfirmed.status).toBe(400);
    const notConfirmed = await env.call<ErrorBody>('POST', '/api/system/update/apply', { confirm: false }, auth);
    expect(notConfirmed.status).toBe(422);
    expect(notConfirmed.body.error.code).toBe('UPDATE_CONFIRM_REQUIRED');
    const dev = await env.call<ErrorBody>('POST', '/api/system/update/apply', { confirm: true }, auth);
    expect(dev.status).toBe(409);
    expect(dev.body.error).toMatchObject({ code: 'UPDATE_NOT_POSSIBLE', message: expect.stringContaining('source code') });
    const countdown = await env.call<ErrorBody>('POST', '/api/system/update/apply', { confirm: true, countdownSeconds: 9999 }, auth);
    expect(countdown.status).toBe(400);
  });

  it('stores the switch for automatic checks in the database', async () => {
    const off = await env.call<SystemUpdateState>('PATCH', '/api/system/update/settings', { autoCheck: false }, auth);
    expect(off.body.autoCheck).toBe(false);
    expect((await env.call<SystemUpdateState>('GET', '/api/system/update', undefined, auth)).body.autoCheck).toBe(false);
    expect((await env.call<ErrorBody>('PATCH', '/api/system/update/settings', { autoCheck: 'ja' }, auth)).status).toBe(400);
  });

  it('cannot cancel or dismiss when nothing runs', async () => {
    expect((await env.call<ErrorBody>('POST', '/api/system/update/cancel', undefined, auth)).body.error.code).toBe('UPDATE_NOT_CANCELABLE');
    expect((await env.call<SystemUpdateState>('POST', '/api/system/update/dismiss', undefined, auth)).body.phase).toBe('idle');
  });

  it('answers a failed check with a readable error', async () => {
    github.apiStatus = 503;
    const res = await env.call<ErrorBody>('POST', '/api/system/update/check', undefined, auth);
    expect(res.status).toBe(502);
    expect(res.body.error.message).toMatch(/HTTP 503/);
  });
});

describe('Content-Type handling', () => {
  it('accepts a bodiless POST with any Content-Type (PowerShell Invoke-RestMethod)', async () => {
    for (const headers of [
      { 'content-type': 'application/x-www-form-urlencoded', 'content-length': '0' },
      { 'content-type': 'application/x-www-form-urlencoded' },
      { 'content-type': 'text/plain', 'content-length': '0' },
      { 'content-type': 'application/octet-stream' },
    ]) {
      const res = await env.app.inject({ method: 'POST', url: '/api/system/update/check', headers: { ...auth, ...headers } });
      expect(res.statusCode, JSON.stringify(headers)).toBe(200);
    }
  });

  it('still rejects a non-empty body of an unsupported type with 415', async () => {
    for (const type of ['text/plain', 'application/x-www-form-urlencoded']) {
      const res = await env.app.inject({
        method: 'POST',
        url: '/api/system/update/apply',
        headers: { ...auth, 'content-type': type },
        payload: 'confirm=true',
      });
      expect(res.statusCode, type).toBe(415);
      expect(res.json<ErrorBody>().error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    }
  });
});
