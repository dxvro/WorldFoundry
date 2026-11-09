import { describe, expect, it } from 'vitest';
import type { RuntimeStatus, ServerView } from '../lib/types';
import { hasLogGap, initialLiveState, liveReducer, mergeInstallLog, needsRefetch, offlineStatus, statusOf, type LiveAction, type LiveState } from './reducer';

const server = (id: string, overrides: Partial<ServerView> = {}): ServerView =>
  ({ id, name: `Server ${id}`, installState: 'installed', installError: null, status: offlineStatus(), ...overrides }) as ServerView;

const status = (overrides: Partial<RuntimeStatus> = {}): RuntimeStatus => ({ ...offlineStatus(), ...overrides });

const apply = (state: LiveState, ...actions: LiveAction[]): LiveState => actions.reduce(liveReducer, state);
const message = (value: unknown): LiveAction => ({ type: 'message', message: value as never });

describe('liveReducer', () => {
  it('replaces all statuses by the snapshot and treats unknown servers as offline afterwards', () => {
    const a = server('a', { status: status({ state: 'online' }) });
    let state = apply(initialLiveState(), { type: 'servers', servers: [a] });
    expect(statusOf(state, a).state).toBe('online');
    state = apply(state, message({ type: 'snapshot', serverTime: 1, servers: [] }));
    expect(statusOf(state, a).state).toBe('offline');
  });

  it('follows status and metrics events', () => {
    const state = apply(
      initialLiveState(),
      message({ type: 'server.status', serverId: 'a', status: status({ state: 'online', pid: 5 }) }),
      message({ type: 'server.metrics', serverId: 'a', cpuPercent: 12.5, rssBytes: 1000 }),
    );
    expect(state.statuses['a']).toMatchObject({ state: 'online', cpuPercent: 12.5, rssBytes: 1000 });
  });

  it('ignores metrics for servers it has no status for', () => {
    const state = apply(initialLiveState(), message({ type: 'server.metrics', serverId: 'zzz', cpuPercent: 1, rssBytes: 1 }));
    expect(state.statuses).toEqual({});
  });

  it('keeps crash details until the server starts again', () => {
    let state = apply(initialLiveState(), message({ type: 'server.status', serverId: 'a', status: status({ state: 'crashed', exitCode: 1 }) }), message({ type: 'server.crashed', serverId: 'a', exitCode: 1, lastLines: ['boom'], lastLinesRefs: [null] }));
    expect(state.crashes['a']).toEqual({ exitCode: 1, lastLines: ['boom'], lastLinesRefs: [null] });
    state = apply(state, message({ type: 'server.status', serverId: 'a', status: status({ state: 'starting' }) }));
    expect(state.crashes['a']).toBeUndefined();
  });

  it('remembers "restart needed" until the next start', () => {
    let state = apply(initialLiveState(), { type: 'restart-needed', serverId: 'a', needed: true });
    expect(state.restartNeeded['a']).toBe(true);
    state = apply(state, message({ type: 'server.status', serverId: 'a', status: status({ state: 'starting' }) }));
    expect(state.restartNeeded['a']).toBeUndefined();
  });

  it('tracks installation progress and a capped log, and patches the server row', () => {
    let state = apply(initialLiveState(), { type: 'servers', servers: [server('a', { installState: 'pending' })] });
    state = apply(
      state,
      message({ type: 'install.state', serverId: 'a', installState: 'installing', installError: null, installErrorRef: null }),
      message({ type: 'install.progress', serverId: 'a', phase: 'download', percent: 40, message: 'server.jar' }),
      message({ type: 'install.log', serverId: 'a', line: 'Line 1', seq: 0, time: 1000 }),
    );
    expect(state.installs['a']).toMatchObject({ phase: 'download', percent: 40, log: [{ seq: 0, time: 1000, text: 'Line 1' }] });
    expect(state.servers?.[0]?.installState).toBe('installing');

    for (let i = 1; i < 600; i++) state = apply(state, message({ type: 'install.log', serverId: 'a', line: `l${i}`, seq: i, time: 1000 + i }));
    expect(state.installs['a']?.log).toHaveLength(400);
    expect(state.installs['a']?.log.at(-1)).toMatchObject({ seq: 599, text: 'l599' });

    state = apply(state, message({ type: 'install.state', serverId: 'a', installState: 'failed', installError: 'Download fehlgeschlagen' }));
    expect(state.servers?.[0]).toMatchObject({ installState: 'failed', installError: 'Download fehlgeschlagen' });
  });

  it('removes everything about a deleted server', () => {
    let state = apply(initialLiveState(), { type: 'servers', servers: [server('a'), server('b')] }, message({ type: 'server.status', serverId: 'a', status: status({ state: 'online' }) }));
    state = apply(state, message({ type: 'server.changed', serverId: 'a', reason: 'deleted' }));
    expect(state.servers?.map((entry) => entry.id)).toEqual(['b']);
    expect(state.statuses['a']).toBeUndefined();
  });

  it('stores the result of the update check after a start', () => {
    const state = apply(initialLiveState(), message({ type: 'mods.updates', serverId: 'a', ok: true, count: 2, projects: ['A', 'B'], error: null }));
    expect(state.modUpdates['a']).toEqual({ ok: true, count: 2, projects: ['A', 'B'], error: null });
  });
});

describe('needsRefetch', () => {
  it('asks for the list after creation, update and finished installs only', () => {
    expect(needsRefetch({ type: 'server.changed', serverId: 'a', reason: 'created' })).toBe(true);
    expect(needsRefetch({ type: 'server.changed', serverId: 'a', reason: 'deleted' })).toBe(false);
    expect(needsRefetch({ type: 'install.state', serverId: 'a', installState: 'installed', installError: null, installErrorRef: null })).toBe(true);
    expect(needsRefetch({ type: 'install.state', serverId: 'a', installState: 'installing', installError: null, installErrorRef: null })).toBe(false);
    expect(needsRefetch({ type: 'server.metrics', serverId: 'a', cpuPercent: 1, rssBytes: 1 })).toBe(false);
  });
});

describe('install log merging', () => {
  const entry = (seq: number, text = `l${seq}`) => ({ seq, time: 1000 + seq, text });

  it('unites lines by number, sorted, with the newer copy winning', () => {
    const merged = mergeInstallLog([entry(0), entry(1), entry(3)], [entry(2), entry(3, 'new'), entry(4)]);
    expect(merged.map((line) => [line.seq, line.text])).toEqual([[0, 'l0'], [1, 'l1'], [2, 'l2'], [3, 'new'], [4, 'l4']]);
  });

  it('caps the log at the newest lines', () => {
    const many = Array.from({ length: 450 }, (_, index) => entry(index));
    const merged = mergeInstallLog([], many);
    expect(merged).toHaveLength(400);
    expect(merged[0]?.seq).toBe(50);
  });

  it('detects missing line numbers', () => {
    expect(hasLogGap([entry(0), entry(1), entry(2)])).toBe(false);
    expect(hasLogGap([entry(5)])).toBe(false);
    expect(hasLogGap([entry(0), entry(2)])).toBe(true);
    expect(hasLogGap([])).toBe(false);
  });

  it('merges a loaded file with live events that came first, without duplicates', () => {
    let state = apply(initialLiveState(), message({ type: 'install.log', serverId: 'a', line: 'live 2', seq: 2, time: 1002 }), message({ type: 'install.log', serverId: 'a', line: 'live 3', seq: 3, time: 1003 }));
    state = apply(state, {
      type: 'install-log',
      serverId: 'a',
      lines: [
        { seq: 0, time: 1000, text: 'datei 0' },
        { seq: 1, time: 1001, text: 'datei 1' },
        { seq: 2, time: 1002, text: 'live 2' },
      ],
    });
    expect(state.installs['a']?.log.map((line) => line.text)).toEqual(['datei 0', 'datei 1', 'live 2', 'live 3']);
  });

  it('keeps the lines when a retry starts, because the file continues', () => {
    let state = apply(initialLiveState(), message({ type: 'install.log', serverId: 'a', line: 'alt', seq: 0, time: 1 }));
    state = apply(state, message({ type: 'install.state', serverId: 'a', installState: 'installing', installError: null, installErrorRef: null }));
    expect(state.installs['a']).toMatchObject({ phase: 'resolve', log: [{ seq: 0, text: 'alt' }] });
  });
});

describe('java and backup events', () => {
  it('tracks the progress of Java installations per major', () => {
    let state = apply(initialLiveState(), message({ type: 'java.install', major: 21, state: 'running', phase: 'download', percent: 12, message: 'loading', error: null }));
    expect(state.javaInstalls[21]).toEqual({ state: 'running', phase: 'download', percent: 12, message: 'loading', error: null });
    state = apply(state, message({ type: 'java.install', major: 21, state: 'failed', phase: 'download', percent: null, message: 'kaputt', error: 'kaputt' }));
    expect(state.javaInstalls[21]).toMatchObject({ state: 'failed', error: 'kaputt' });
    expect(state.javaInstalls[17]).toBeUndefined();
  });

  it('counts backup changes per server so lists can reload', () => {
    let state = apply(initialLiveState(), message({ type: 'backup.changed', serverId: 'a', backupId: 'b', kind: 'manual', status: 'running', error: null }));
    state = apply(state, message({ type: 'backup.changed', serverId: 'a', backupId: 'b', kind: 'manual', status: 'ok', error: null }));
    expect(state.backupTicks).toEqual({ a: 2 });
    state = apply(state, message({ type: 'server.changed', serverId: 'a', reason: 'deleted' }));
    expect(state.backupTicks['a']).toBeUndefined();
  });

  it('treats the preparing state like a start: crash details and the restart hint are cleared', () => {
    let state = apply(initialLiveState(), message({ type: 'server.crashed', serverId: 'a', exitCode: null, lastLines: ['x'], lastLinesRefs: [null] }), { type: 'restart-needed', serverId: 'a', needed: true });
    state = apply(state, message({ type: 'server.status', serverId: 'a', status: status({ state: 'preparing', message: 'Installing Java 21 ...' }) }));
    expect(state.crashes['a']).toBeUndefined();
    expect(state.restartNeeded['a']).toBeUndefined();
    expect(state.statuses['a']?.state).toBe('preparing');
  });
});
