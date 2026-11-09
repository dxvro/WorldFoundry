import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appSettings, updateHistory } from '../src/db/schema.js';
import type { AppEvent } from '../src/events/bus.js';
import { UpdateService } from '../src/update/service.js';
import type { SystemUpdateState, UpdatePhase } from '../src/update/types.js';
import { buildRelease, FakeGithub, makeKeys, type TestKeys } from './fake-github.js';
import { scratchDir, ServerEnv, waitFor } from './server-env.js';

interface ErrorBody {
  error: { code: string; message: string };
}

let env: ServerEnv;
let github: FakeGithub;
let keys: TestKeys;
let updateDir: string;
let events: AppEvent[];

async function setup(overrides: { timings?: Record<string, number>; mode?: 'service' | 'portable' } = {}): Promise<void> {
  github = new FakeGithub();
  keys = makeKeys();
  updateDir = await scratchDir('cm-updater-');
  await mkdir(path.join(updateDir, 'request'), { recursive: true });
  env = await ServerEnv.create({
    config: { updateCheck: true, updateRepo: 'owner/repo', updateDir, updateCountdownSeconds: 0 },
    update: {
      currentVersion: '0.1.0',
      fetch: github.fetch as typeof fetch,
      keys: [{ id: 'test', publicKey: keys.publicPem }],
      mode: overrides.mode === 'portable' ? { mode: 'portable', note: 'Note only.' } : { mode: 'service', note: null },
      platform: 'linux',
      arch: 'x64',
      timings: { bootDelayMs: 3_600_000, statusPollMs: 10, pickupTimeoutMs: 600, installTimeoutMs: 5000, tickMs: 5, httpTimeoutMs: 2000, ...overrides.timings },
    },
  });
  events = [];
  env.services.bus.subscribe((event) => events.push(event));
}

beforeEach(async () => {
  await setup();
});
afterEach(async () => {
  await env.services.update.idle().catch(() => undefined);
  await env.close();
});

const release = (version: string, extra: Partial<Parameters<typeof buildRelease>[0]> = {}) => github.add(buildRelease({ version, keys, ...extra }));
const state = (): SystemUpdateState => env.services.update.snapshot();
const phases = (): UpdatePhase[] => {
  const seen: UpdatePhase[] = [];
  for (const event of events) if (event.type === 'update.state' && seen[seen.length - 1] !== event.state.phase) seen.push(event.state.phase);
  return seen;
};
const requestFiles = async (): Promise<string[]> => (await readdir(path.join(updateDir, 'request'))).sort();
const writeStatus = async (id: string, status: string, message: string): Promise<void> => {
  await writeFile(path.join(updateDir, 'status.json'), JSON.stringify({ schema: 1, id, state: status, version: '0.2.0', from: '0.1.0', message, updatedAt: Date.now() }));
};
const waitPhase = (phase: UpdatePhase, timeout = 5000) => waitFor(() => (state().phase === phase ? state() : undefined), timeout, `Phase ${phase}`);

async function startedServer(): Promise<string> {
  const server = await env.addServer();
  await env.call('POST', `/api/servers/${server.id}/start`);
  await env.waitState(server.id, 'online');
  return server.id;
}

describe('checking for updates', () => {
  it('finds a newer stable release and keeps the result', async () => {
    release('0.2.0', { notes: 'New: **Update**' });
    release('0.3.0-rc.1', { prerelease: true });
    release('0.1.0');
    const result = await env.services.update.checkNow();
    expect(result).toMatchObject({ currentVersion: '0.1.0', updateAvailable: true, canApply: true, installMode: 'service', lastCheckError: null });
    expect(result.latest).toMatchObject({ version: '0.2.0', notes: 'New: **Update**', prerelease: false });
    expect(result.latest?.assetSizeBytes).toBeGreaterThan(0);
    expect(github.hosts).toEqual(['api.github.com']);
    // persisted: a fresh service instance shows it right after a restart
    const again = new UpdateService({ db: env.t.db, config: env.config, bus: env.services.bus, manager: env.services.manager, currentVersion: '0.1.0', mode: { mode: 'service', note: null } });
    await again.start();
    expect(again.snapshot().latest?.version).toBe('0.2.0');
    again.stop();
  });

  it('says nothing is available for the same, an older or only a prerelease version', async () => {
    release('0.1.0');
    release('0.2.0-rc.1', { prerelease: true });
    expect(await env.services.update.checkNow()).toMatchObject({ updateAvailable: false, canApply: false, canApplyReason: 'There is no newer release.', canApplyReasonRef: { key: 'UPDATE_NO_NEWER' } });
  });

  it('reports a failing check with a message and keeps the previous result', async () => {
    release('0.2.0');
    await env.services.update.checkNow();
    github.apiStatus = 500;
    await expect(env.services.update.checkNow()).rejects.toMatchObject({ code: 'UPDATE_DOWNLOAD_FAILED' });
    expect(state().lastCheckError).toMatch(/HTTP 500/);
    expect(state().latest?.version).toBe('0.2.0');
  });

  it('only notifies in portable mode', async () => {
    await env.close();
    await setup({ mode: 'portable' });
    release('0.2.0');
    const result = await env.services.update.checkNow();
    expect(result).toMatchObject({ updateAvailable: true, canApply: false, installMode: 'portable', canApplyReason: 'Note only.' });
    await expect(env.services.update.apply({ confirm: true })).rejects.toMatchObject({ code: 'UPDATE_NOT_POSSIBLE' });
  });

  it('refuses checks when UPDATE_CHECK=false', async () => {
    await env.close();
    github = new FakeGithub();
    env = await ServerEnv.create({ config: { updateCheck: false }, update: { fetch: github.fetch as typeof fetch } });
    await expect(env.services.update.checkNow()).rejects.toMatchObject({ code: 'UPDATE_DISABLED' });
    expect(state()).toMatchObject({ checksEnabled: false, canApply: false });
    expect(github.requests).toEqual([]);
  });

  it('schedules automatic checks with jitter and honours the switch', async () => {
    await env.close();
    await setup({ timings: { bootDelayMs: 20, bootJitterMs: 1, intervalMs: 60 } });
    release('0.2.0');
    await env.services.update.setAutoCheck(false);
    await env.services.update.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(github.requests).toEqual([]);
    await env.services.update.setAutoCheck(true);
    await waitFor(() => (state().latest?.version === '0.2.0' ? true : undefined), 2000, 'automatic check');
    expect(state().autoCheck).toBe(true);
  });
});

describe('applying an update', () => {
  it('needs an explicit confirmation', async () => {
    release('0.2.0');
    await env.services.update.checkNow();
    await expect(env.services.update.apply({ confirm: false })).rejects.toMatchObject({ statusCode: 422, code: 'UPDATE_CONFIRM_REQUIRED' });
    expect(state().phase).toBe('idle');
  });

  it('warns the players, stops the servers cleanly, hands over a verified request and restarts the servers when the updater reports a failure', async () => {
    release('0.2.0');
    const serverId = await startedServer();
    await env.services.update.checkNow();
    const applied = await env.services.update.apply({ confirm: true, countdownSeconds: 3 });
    expect(applied.phase).toBe('downloading');

    await waitPhase('installing');
    // chat warnings with countdown, stop with the regular stop logic
    const lines = env.services.manager.history(serverId).map((line) => line.text);
    expect(lines.filter((line) => line.includes('Software update')).length).toBeGreaterThan(0);
    expect(lines.some((line) => line.includes('in 3 seconds'))).toBe(true);
    expect(env.services.manager.status(serverId).state).toBe('offline');
    const row = await env.row(serverId);
    expect(row?.lastExitCode).toBe(0);

    // the request: payload, sums, signature and request.json last
    await waitFor(async () => ((await requestFiles()).includes('request.json') ? true : undefined), 3000, 'request');
    expect(await requestFiles()).toEqual(['SHA256SUMS.txt', 'SHA256SUMS.txt.sig', 'request.json', 'worldfoundry-0.2.0-linux-x64.tar.gz']);
    const request = JSON.parse(await readFile(path.join(updateDir, 'request', 'request.json'), 'utf8')) as { id: string; version: string; from: string; assetName: string };
    expect(request).toMatchObject({ version: '0.2.0', from: '0.1.0', assetName: 'worldfoundry-0.2.0-linux-x64.tar.gz' });
    expect(state().job).toMatchObject({ toVersion: '0.2.0', servers: 1 });

    // a running hand-over is blocking
    expect(env.services.update.blocking).toBe(true);

    // the updater (here: the test) refuses; the servers come back
    await writeStatus(request.id, 'failed', 'The signature of the release is invalid.');
    await waitPhase('failed');
    expect(state().error).toBe('The signature of the release is invalid.');
    expect(state().history[0]).toMatchObject({ fromVersion: '0.1.0', toVersion: '0.2.0', result: 'failed', stoppedServers: 1 });
    await env.waitState(serverId, 'online');
    expect(state().job).toBeNull();
    expect(await requestFiles()).toEqual([]);
    expect(phases()).toEqual(['idle', 'downloading', 'verifying', 'waiting-for-servers', 'installing', 'failed']);
  });

  it('tells the progress of the updater (restarting) and records a rollback', async () => {
    release('0.2.0');
    await env.services.update.checkNow();
    await env.services.update.apply({ confirm: true });
    await waitPhase('installing');
    const request = await waitFor(async () => {
      try {
        return JSON.parse(await readFile(path.join(updateDir, 'request', 'request.json'), 'utf8')) as { id: string };
      } catch {
        return undefined;
      }
    });
    await writeStatus(request.id, 'installing', 'The new version is being installed …');
    await waitPhase('restarting');
    await writeStatus(request.id, 'rolled-back', 'The new version does not respond. The previous version is running again.');
    await waitPhase('failed');
    expect(state().history[0]).toMatchObject({ result: 'rolled_back', message: expect.stringContaining('previous version') });
  });

  it('fails readably when no updater answers, and brings the servers back', async () => {
    release('0.2.0');
    const serverId = await startedServer();
    await env.services.update.checkNow();
    await env.services.update.apply({ confirm: true });
    await waitPhase('failed', 8000);
    expect(state().error).toMatch(/update service/);
    expect(await requestFiles()).toEqual([]);
    await env.waitState(serverId, 'online');
  });

  it('rejects a tampered asset before any server is touched', async () => {
    release('0.2.0', { tamperAsset: true });
    const serverId = await startedServer();
    await env.services.update.checkNow();
    await env.services.update.apply({ confirm: true, countdownSeconds: 30 });
    await waitPhase('failed');
    expect(state().error).toMatch(/checksum/);
    expect(state().errorRef).toMatchObject({ key: 'UPDATE_HASH_MISMATCH' });
    expect(env.services.manager.status(serverId).state).toBe('online');
    expect(await requestFiles()).toEqual([]);
    expect(state().history[0]).toMatchObject({ result: 'failed', stoppedServers: 0 });
    // nothing is left in the download folder
    const leftovers = await readdir(path.join(env.config.dataDir, 'updates')).catch(() => []);
    expect(leftovers.filter((name) => !name.startsWith('db-before'))).toEqual([]);
  });

  it.each([
    ['signed with another key', { signWith: makeKeys() }, /signature/],
    ['tampered sums', { tamperSums: true }, /signature/],
  ])('rejects a release %s', async (_label, extra, message) => {
    release('0.2.0', extra);
    const serverId = await startedServer();
    await env.services.update.checkNow();
    await env.services.update.apply({ confirm: true });
    await waitPhase('failed');
    expect(state().error).toMatch(message);
    expect(env.services.manager.status(serverId).state).toBe('online');
  });

  it('does not offer a release without signed sums', async () => {
    release('0.2.0', { withoutSignature: true });
    const result = await env.services.update.checkNow();
    expect(result).toMatchObject({ updateAvailable: true, canApply: false, canApplyReason: expect.stringContaining('signed checksums') });
  });

  it('can be cancelled during the countdown without stopping anything', async () => {
    release('0.2.0');
    const serverId = await startedServer();
    await env.services.update.checkNow();
    await env.services.update.apply({ confirm: true, countdownSeconds: 600 });
    await waitPhase('waiting-for-servers');
    await waitFor(() => (state().progress?.countdownRemaining != null ? true : undefined), 3000, 'Countdown');
    await env.services.update.cancel();
    await waitPhase('idle');
    expect(env.services.manager.status(serverId).state).toBe('online');
    expect(state().history[0]).toMatchObject({ result: 'cancelled', messageRef: { key: 'UPDATE_CANCELLED_BY_ADMIN' } });
    expect(env.services.manager.history(serverId).some((line) => line.text.includes('cancelled'))).toBe(true);
  });

  it('cannot be cancelled once the servers are being stopped', async () => {
    release('0.2.0');
    await env.services.update.checkNow();
    await env.services.update.apply({ confirm: true });
    await waitPhase('installing');
    await expect(env.services.update.cancel()).rejects.toMatchObject({ code: 'UPDATE_NOT_CANCELABLE' });
  });

  it('refuses a second update and blocks starting servers while it runs', async () => {
    release('0.2.0');
    const serverId = await startedServer();
    await env.services.update.checkNow();
    await env.services.update.apply({ confirm: true, countdownSeconds: 600 });
    await waitPhase('waiting-for-servers');
    await expect(env.services.update.apply({ confirm: true })).rejects.toMatchObject({ code: 'UPDATE_NOT_POSSIBLE' });
    await expect(env.services.update.checkNow()).rejects.toMatchObject({ code: 'UPDATE_BUSY' });

    const other = await env.addServer();
    for (const [method, url] of [
      ['POST', `/api/servers/${other.id}/start`],
      ['POST', `/api/servers/${other.id}/install`],
      ['POST', '/api/servers'],
      ['DELETE', `/api/servers/${other.id}?confirm=true`],
      ['PATCH', `/api/servers/${other.id}`],
      ['POST', '/api/java/runtimes/21/install'],
    ] as const) {
      const res = await env.call<ErrorBody>(method, url, method === 'POST' && url === '/api/servers' ? { name: 'x', loader: 'vanilla', mcVersion: '1.21.1' } : undefined);
      expect(res.status, `${method} ${url}`).toBe(409);
      expect(res.body.error.code).toBe('UPDATE_IN_PROGRESS');
    }
    // the manager refuses too, whoever asks
    await expect(env.services.manager.start(other.id)).rejects.toMatchObject({ code: 'UPDATE_IN_PROGRESS' });
    // stopping and console commands stay possible
    expect((await env.call('POST', `/api/servers/${serverId}/command`, { command: 'list' })).status).toBe(200);
    await env.services.update.cancel();
    await waitPhase('idle');
    expect((await env.call('POST', `/api/servers/${other.id}/start`)).status).toBe(200);
  });

  it('refuses while a server installation is running', async () => {
    release('0.2.0');
    await env.services.update.checkNow();
    await env.addServer({ installState: 'installing' });
    await expect(env.services.update.apply({ confirm: true })).rejects.toMatchObject({ code: 'UPDATE_BLOCKED' });
  });
});

describe('after the restart', () => {
  async function seededJob(overrides: { to: string; serverIds: string[]; step?: string }): Promise<void> {
    const job = { id: 'job-12345678', fromVersion: '0.0.9', toVersion: overrides.to, startedAt: Date.now() - 1000, serverIds: overrides.serverIds, step: overrides.step ?? 'handed-over' };
    await env.t.db.insert(appSettings).values({ key: 'update.job', value: JSON.stringify(job), updatedAt: new Date() });
  }
  const fresh = (version: string, timings: Record<string, number> = {}): UpdateService =>
    new UpdateService({
      db: env.t.db,
      config: env.config,
      bus: env.services.bus,
      manager: env.services.manager,
      currentVersion: version,
      mode: { mode: 'service', note: null },
      timings: { statusPollMs: 10, installTimeoutMs: 300, ...timings },
    });

  it('renders history rows written before message references existed from their stored text', async () => {
    await env.t.db.insert(updateHistory).values({
      fromVersion: '0.0.1',
      toVersion: '0.0.2',
      result: 'failed',
      message: 'Das Update ist fehlgeschlagen.',
      stoppedServers: 0,
      startedAt: new Date(1000),
      finishedAt: new Date(2000),
    });
    const service = fresh('0.1.0');
    await service.start();
    expect(service.snapshot().history).toEqual([
      expect.objectContaining({ message: 'Das Update ist fehlgeschlagen.', messageRef: null, result: 'failed' }),
    ]);
    service.stop();
  });

  it('records success and starts the servers that ran before', async () => {
    const server = await env.addServer();
    await seededJob({ to: '0.1.0', serverIds: [server.id] });
    const service = fresh('0.1.0');
    await service.start();
    await service.idle();
    expect(service.snapshot()).toMatchObject({ phase: 'done', error: null, job: null });
    expect(service.snapshot().history[0]).toMatchObject({ fromVersion: '0.0.9', toVersion: '0.1.0', result: 'success', stoppedServers: 1 });
    expect(service.snapshot().history[0]).toMatchObject({ message: 'Updated to version 0.1.0.', messageRef: { key: 'UPDATE_SUCCESS', params: { version: '0.1.0' } } });
    await env.waitState(server.id, 'online');
    service.stop();
  });

  it('records a rollback reported by the updater and still restarts the servers', async () => {
    const server = await env.addServer();
    await seededJob({ to: '9.9.9', serverIds: [server.id] });
    await writeStatus('job-12345678', 'rolled-back', 'The previous version is running again.');
    const service = fresh('0.1.0');
    await service.start();
    await service.idle();
    expect(service.snapshot()).toMatchObject({ phase: 'failed', error: 'The previous version is running again.' });
    expect(service.snapshot().history[0]?.result).toBe('rolled_back');
    await env.waitState(server.id, 'online');
    service.stop();
  });

  it('treats a missing report as a failure after the timeout', async () => {
    await seededJob({ to: '9.9.9', serverIds: [] });
    const service = fresh('0.1.0');
    await service.start();
    await service.idle();
    expect(service.snapshot().history[0]).toMatchObject({ result: 'failed', message: expect.stringContaining('did not report back') });
    service.stop();
  });

  it('settles an update that was interrupted before the hand-over', async () => {
    const server = await env.addServer();
    await seededJob({ to: '9.9.9', serverIds: [server.id], step: 'stopping' });
    const service = fresh('0.1.0');
    await service.start();
    await service.idle();
    expect(service.snapshot().history[0]).toMatchObject({ result: 'failed', message: expect.stringContaining('interrupted') });
    await env.waitState(server.id, 'online');
    service.stop();
  });
});

describe('what a test build may do', () => {
  async function installFolder(marker: Record<string, unknown> | null): Promise<string> {
    const root = await scratchDir('cm-install-');
    if (marker !== null) {
      await mkdir(path.join(root, 'tools'), { recursive: true });
      await writeFile(path.join(root, 'tools', 'update-test.json'), JSON.stringify(marker));
    }
    return root;
  }

  const build = (installRoot: string, apiBase: string | undefined, fetchImpl: typeof fetch): UpdateService =>
    new UpdateService({
      db: env.t.db,
      config: { ...env.config, ...(apiBase === undefined ? {} : { updateApiBase: apiBase }) },
      bus: env.services.bus,
      manager: env.services.manager,
      currentVersion: '0.1.0',
      installRoot,
      fetch: fetchImpl,
      mode: { mode: 'service', note: null },
    });

  it('ignores UPDATE_API_BASE and extra keys in a normal package', async () => {
    const seen: string[] = [];
    const spy: typeof fetch = async (input) => {
      seen.push(new URL(typeof input === 'string' || input instanceof URL ? input : input.url).href);
      return new Response('[]', { status: 200 });
    };
    const service = build(await installFolder(null), 'http://127.0.0.1:4599', spy);
    await service.checkNow();
    expect(seen).toEqual(['https://api.github.com/repos/owner/repo/releases?per_page=30']);
  });

  it('honours the address only with the marker file of a test package, and then also accepts plain http', async () => {
    const seen: string[] = [];
    const spy: typeof fetch = async (input) => {
      seen.push(new URL(typeof input === 'string' || input instanceof URL ? input : input.url).href);
      return new Response('[]', { status: 200 });
    };
    const root = await installFolder({ apiBase: 'http://127.0.0.1:4599', trustedKeys: [{ id: 'ci', publicKey: keys.publicPem }] });
    await build(root, undefined, spy).checkNow();
    await build(root, 'http://127.0.0.1:4777', spy).checkNow();
    expect(seen).toEqual(['http://127.0.0.1:4599/repos/owner/repo/releases?per_page=30', 'http://127.0.0.1:4777/repos/owner/repo/releases?per_page=30']);
  });
});
