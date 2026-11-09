import { describe, expect, it } from 'vitest';
import { ModrinthClient } from '../src/modrinth/client.js';

const project = { id: 'P1', slug: 'p', title: 'P', project_type: 'mod', extra: 'ignored' };
const json = (value: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' }, ...init });

function client(responses: Array<Response | Error>, sleeps: number[] = [], maxAttempts = 4) {
  const calls: Array<{ url: URL; headers: Headers }> = [];
  let index = 0;
  const fakeFetch: typeof fetch = async (input, init) => {
    calls.push({ url: new URL(String(input)), headers: new Headers(init?.headers) });
    const next = responses[Math.min(index++, responses.length - 1)];
    if (next instanceof Error) throw next;
    return (next as Response).clone();
  };
  return {
    calls,
    api: new ModrinthClient({
      userAgent: 'WorldFoundry/9.9.9',
      fetch: fakeFetch,
      maxAttempts,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    }),
  };
}

describe('ModrinthClient', () => {
  it('sends the User-Agent and tolerates extra fields', async () => {
    const { api, calls } = client([json(project)]);
    expect((await api.getProject('p')).title).toBe('P');
    expect(calls[0]?.headers.get('user-agent')).toBe('WorldFoundry/9.9.9');
    expect(calls[0]?.url.href).toBe('https://api.modrinth.com/v2/project/p');
  });

  it('encodes loaders and game_versions as JSON query params', async () => {
    const { api, calls } = client([json([])]);
    await api.listProjectVersions('P1', ['paper', 'spigot'], ['1.21.1']);
    expect(calls[0]?.url.searchParams.get('loaders')).toBe('["paper","spigot"]');
    expect(calls[0]?.url.searchParams.get('game_versions')).toBe('["1.21.1"]');
  });

  it('waits for X-Ratelimit-Reset on 429 and retries', async () => {
    const sleeps: number[] = [];
    const { api, calls } = client([new Response('', { status: 429, headers: { 'x-ratelimit-reset': '7' } }), json(project)], sleeps);
    await api.getProject('p');
    expect(sleeps).toEqual([7000]);
    expect(calls).toHaveLength(2);
  });

  it('gives up on persistent 429 with MODRINTH_RATE_LIMITED', async () => {
    const { api } = client([new Response('', { status: 429 })], [], 2);
    await expect(api.getProject('p')).rejects.toMatchObject({ statusCode: 503, code: 'MODRINTH_RATE_LIMITED' });
  });

  it('retries 5xx with backoff and finally reports MODRINTH_UNREACHABLE', async () => {
    const sleeps: number[] = [];
    const { api, calls } = client([new Response('', { status: 503 })], sleeps, 3);
    await expect(api.getProject('p')).rejects.toMatchObject({ statusCode: 502, code: 'MODRINTH_UNREACHABLE' });
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([500, 1000]);
  });

  it('recovers from a transient network error', async () => {
    const { api } = client([new TypeError('fetch failed'), json(project)]);
    expect((await api.getProject('p')).id).toBe('P1');
  });

  it('maps timeouts to MODRINTH_TIMEOUT', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const { api } = client([timeout], [], 2);
    await expect(api.getProject('p')).rejects.toMatchObject({ statusCode: 504, code: 'MODRINTH_TIMEOUT' });
  });

  it('maps 404 to MOD_NOT_FOUND without retrying', async () => {
    const { api, calls } = client([new Response('', { status: 404 })]);
    await expect(api.getVersion('x')).rejects.toMatchObject({ statusCode: 404, code: 'MOD_NOT_FOUND' });
    expect(calls).toHaveLength(1);
  });

  it('rejects malformed payloads', async () => {
    const { api } = client([json({ id: 1 })]);
    await expect(api.getProject('p')).rejects.toMatchObject({ code: 'MODRINTH_BAD_RESPONSE' });
  });

  it('caches categories', async () => {
    const { api, calls } = client([json([{ name: 'a', project_type: 'mod', header: 'categories' }])]);
    await api.categories();
    await api.categories();
    expect(calls).toHaveLength(1);
  });
});
