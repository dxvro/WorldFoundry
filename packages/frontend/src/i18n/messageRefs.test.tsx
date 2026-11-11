import { render, screen } from '@testing-library/react';
import type { MessageRef } from '@worldfoundry/backend/contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { NoticeList } from '../components/WorldImport';
import { ApiError, errorFromResponse } from '../lib/api';
import { FakeSocket } from '../test/fakes';
import { baseRoutes, mockApi, offline, serverFixture } from '../test/mockApi';
import { I18nProvider, en, errorMessage, renderOptionalRef, renderRef, resolveRef } from './index';

// The references the backend sends next to its texts: rendered from the dictionary, with the backend text as the fallback.

beforeEach(() => {
  FakeSocket.reset();
  vi.stubGlobal('WebSocket', FakeSocket);
});
afterEach(() => vi.unstubAllGlobals());

describe('renderRef', () => {
  it('renders a message key with its params from the dictionary', () => {
    const ref: MessageRef = { key: 'SERVER_STARTING', params: { major: 21, port: 25565 } };
    expect(renderRef(ref, en, 'fallback')).toBe('Starting the server (Java 21, port 25565) ...');
  });

  it('words the exit of a server from structured params', () => {
    const at = (params: Record<string, string | number>): MessageRef => ({ key: 'SERVER_EXITED_UNEXPECTEDLY', params });
    expect(renderRef(at({ code: 1 }), en, 'x')).toBe('The server exited unexpectedly (exit code 1).');
    expect(renderRef(at({ signal: 'SIGKILL' }), en, 'x')).toBe('The server exited unexpectedly (Signal SIGKILL).');
    expect(renderRef({ key: 'SERVER_STOPPED' }, en, 'x')).toBe('Server stopped (exit code unknown).');
  });

  it('renders INSTALLER_FAILED and PLAYER_LOOKUP_FAILED from their params', () => {
    const exit: MessageRef = { key: 'INSTALLER_FAILED', params: { reason: 'exit', exitCode: 3, output: 'boom' } };
    expect(renderRef(exit, en, 'x')).toBe('The installer failed with exit code 3.\nLast output:\nboom');
    expect(renderRef({ key: 'INSTALLER_FAILED', params: { reason: 'not-started' } }, en, 'x')).toBe('The installer could not be started. Is the Java file valid?');
    expect(renderRef({ key: 'PLAYER_LOOKUP_FAILED', params: { reason: 'timeout' } }, en, 'x')).toContain('did not respond in time');
    expect(renderRef({ key: 'PLAYER_LOOKUP_FAILED', params: { reason: 'rate-limited' } }, en, 'x')).toContain('rate limiting');
    expect(renderRef({ key: 'PLAYER_LOOKUP_FAILED', params: { reason: 'http', status: 503 } }, en, 'x')).toContain('HTTP 503');
  });

  it('renders a key without params as its plain text', () => {
    expect(renderRef({ key: 'SERVER_STOPPING' }, en, 'fallback')).toBe('Stopping the server ...');
  });

  it('renders an AppError code with the params of the error', () => {
    const ref: MessageRef = { key: 'UPSTREAM_UNREACHABLE', params: { host: 'api.adoptium.net' } };
    expect(renderRef(ref, en, 'fallback')).toBe('The service "api.adoptium.net" cannot be reached. Please check the internet connection.');
  });

  it('shows several references one after the other for MESSAGE_LIST', () => {
    const ref: MessageRef = { key: 'MESSAGE_LIST', params: { '1': { key: 'SERVER_STOPPING' }, '2': { key: 'UPDATE_PROGRESS_FINISHING' } } };
    expect(renderRef(ref, en, 'fallback')).toBe('Stopping the server ... Finishing the update …');
  });

  it('renders a nested reference before the text that holds it', () => {
    const ref: MessageRef = { key: 'START_NOTE', params: { note: { key: 'JAVA_FORGE_OLD_NOTE' } } };
    expect(renderRef(ref, en, 'fallback')).toBe(
      'Note: Forge for Minecraft up to 1.16.5 often does not run with Java versions newer than 11. Java 8 is recommended.',
    );
  });

  it('falls back to the given text for no reference, unknown keys and missing params', () => {
    expect(renderRef(null, en, 'English backend text')).toBe('English backend text');
    expect(renderRef(undefined, en, 'English backend text')).toBe('English backend text');
    expect(renderRef({ key: 'NOT_A_KEY' }, en, 'fb')).toBe('fb');
    expect(renderRef({ key: 'toString' }, en, 'fb')).toBe('fb');
    // a required param is missing: the text would be incomplete, so the backend text is shown
    expect(renderRef({ key: 'SERVER_STARTING', params: { major: 21 } }, en, 'fb')).toBe('fb');
    expect(renderRef({ key: 'UPSTREAM_UNREACHABLE' }, en, 'fb')).toBe('fb');
    // a nested reference that cannot be rendered makes the whole text fall back
    expect(renderRef({ key: 'START_NOTE', params: { note: { key: 'NOT_A_KEY' } } }, en, 'fb')).toBe('fb');
    // a MESSAGE_LIST with one unknown part
    expect(renderRef({ key: 'MESSAGE_LIST', params: { '1': { key: 'SERVER_STOPPING' }, '2': { key: 'NOT_A_KEY' } } }, en, 'fb')).toBe('fb');
  });

  it('keeps an optional param out of the check: the text without it is still rendered', () => {
    expect(renderRef({ key: 'NETWORK_PORT_IN_USE', params: { port: 25565 } }, en, 'fb')).toBe(
      'The port is already in use, by another program or by a Minecraft server. Please choose a free port.',
    );
    expect(renderRef({ key: 'NETWORK_PORT_IN_USE', params: { port: 25565, server: 'Survival' } }, en, 'fb')).toBe(
      'The port is already used by the server "Survival". Please choose a free port.',
    );
  });

  it('resolves to null when nothing can be rendered, and renderOptionalRef keeps the text', () => {
    expect(resolveRef({ key: 'NOT_A_KEY' }, en)).toBeNull();
    expect(resolveRef(null, en)).toBeNull();
    expect(renderOptionalRef(null, en, undefined)).toBeUndefined();
    expect(renderOptionalRef(null, en, 'text only')).toBe('text only');
    expect(renderOptionalRef({ key: 'SERVER_STOPPING' }, en, 'text only')).toBe('Stopping the server ...');
  });
});

describe('errors with params', () => {
  it('words an error by its code and params, from the dictionary', () => {
    const error = new ApiError(502, 'UPSTREAM_UNREACHABLE', 'The service api.adoptium.net cannot be reached.', undefined, { host: 'api.adoptium.net' });
    expect(errorMessage(error, en)).toBe('The service "api.adoptium.net" cannot be reached. Please check the internet connection.');
  });

  it('renders a nested reference of an error, and shows the backend text when it cannot', () => {
    const blocked = new ApiError(409, 'UPDATE_BLOCKED', 'x', undefined, { reason: { key: 'UPDATE_WAIT_INSTALL' } });
    expect(errorMessage(blocked, en)).toBe('The update is blocked at the moment: A server installation is currently running. The update is possible afterwards.');
    const broken = new ApiError(409, 'UPDATE_BLOCKED', 'English backend text', undefined, { reason: { key: 'NOT_A_KEY' } });
    expect(errorMessage(broken, en)).toBe('English backend text');
  });

  it('keeps the params of an error body', () => {
    const error = errorFromResponse(502, JSON.stringify({ error: { code: 'UPSTREAM_UNREACHABLE', message: 'm', params: { host: 'h' } } }));
    expect(error.params).toEqual({ host: 'h' });
  });
});

describe('the messages are rendered from their references', () => {
  it('shows the status message of a server that waits for Java', async () => {
    const status = { ...offline, state: 'preparing', message: 'Installing Java 21 ...', messageRef: { key: 'JAVA_INSTALLING', params: { major: 21 } } };
    mockApi({
      ...baseRoutes(serverFixture({ status })),
      'GET /api/servers/srv-1/console/history': () => ({ body: { lines: [] } }),
    });
    window.history.replaceState(null, '', '/servers/srv-1');
    render(<App />);
    expect((await screen.findAllByText('Installing Java 21 ...')).length).toBeGreaterThan(0);
  });

  it('shows a system line of the console from its reference', async () => {
    mockApi({
      ...baseRoutes(serverFixture({ status: { ...offline, state: 'online', pid: 1, startedAt: null, exitCode: null, port: 25565 } })),
      'GET /api/servers/srv-1/console/history': () => ({ body: { lines: [] } }),
    });
    window.history.replaceState(null, '', '/servers/srv-1/console');
    render(<App />);
    const socket = await vi.waitFor(() => {
      const found = FakeSocket.instances.find((entry) => entry.url.includes('/console'));
      if (found === undefined) throw new Error('no console socket yet');
      return found;
    });
    socket.open();
    socket.receive({
      type: 'history',
      lines: [{ seq: 1, time: 1_700_000_000_000, stream: 'system', text: 'Stopping the server ...', textRef: { key: 'SERVER_STOPPING' } }],
    });
    expect(await screen.findByText('Stopping the server ...')).toBeInTheDocument();
  });

  it('shows an import notice from its params', () => {
    const notice = {
      code: 'OTHER_WORLDS',
      level: 'info' as const,
      text: 'Other worlds are not imported: World A and 2 more.',
      needsConfirm: false,
      params: { names: 'World A', more: 2 },
    };
    render(
      <I18nProvider>
        <NoticeList notices={[notice]} acknowledged={[]} onToggle={() => undefined} />
      </I18nProvider>,
    );
    expect(screen.getByText('The archive contains other worlds that are not imported: World A and 2 more.')).toBeInTheDocument();
  });

  it('shows the progress message of an update from its reference', async () => {
    const update = {
      currentVersion: '0.3.0',
      installMode: 'service',
      installModeNote: null,
      installModeNoteRef: null,
      checksEnabled: true,
      autoCheck: true,
      channel: 'stable',
      repo: 'dxvro/WorldFoundry',
      countdownSeconds: 60,
      checking: false,
      lastCheckAt: null,
      lastCheckError: null,
      lastCheckErrorRef: null,
      latest: { version: '0.4.0', name: null, notes: '', publishedAt: null, htmlUrl: 'https://example.invalid', prerelease: false, assetSizeBytes: null },
      updateAvailable: true,
      canApply: false,
      canApplyReason: null,
      canApplyReasonRef: null,
      phase: 'downloading',
      progress: { message: 'Downloading update to 0.4.0 …', messageRef: { key: 'UPDATE_PROGRESS_DOWNLOADING', params: { version: '0.4.0' } }, percent: 40, countdownRemaining: null },
      error: null,
      errorRef: null,
      job: null,
      history: [],
    };
    mockApi({
      ...baseRoutes(serverFixture({ status: offline })),
      'GET /api/system/update': () => ({ body: update }),
    });
    window.history.replaceState(null, '', '/system');
    render(<App />);
    expect(await screen.findByText('Downloading update to 0.4.0 …')).toBeInTheDocument();
  });

  it('shows the note of a backup from its reference', async () => {
    const backup = {
      id: 'b1',
      serverId: 'srv-1',
      kind: 'manual',
      status: 'ok',
      fileName: 'b1.tar.gz',
      sizeBytes: 5 * 1024 * 1024,
      rawBytes: 9 * 1024 * 1024,
      includesConfig: false,
      levelName: 'world',
      worlds: ['world'],
      note: 'English note of the backup',
      noteRef: { key: 'BACKUP_NOTE_BEFORE_RESTORE', params: { fileName: 'b1.tar.gz' } },
      error: null,
      errorRef: null,
      createdAt: '2025-03-01T10:00:00.000Z',
      finishedAt: '2025-03-01T10:00:05.000Z',
    };
    mockApi({
      ...baseRoutes(serverFixture({ status: offline })),
      'GET /api/servers/srv-1/backups': () => ({ body: { backups: [backup], schedule: { intervalHours: null, keepLast: 7, includeConfig: false }, totalBytes: 0, freeBytes: 50 * 1024 ** 3, running: false } }),
    });
    window.history.replaceState(null, '', '/servers/srv-1/backups');
    render(<App />);
    expect(await screen.findByText('Created automatically before restoring b1.tar.gz.')).toBeInTheDocument();
    expect(screen.queryByText('English note of the backup')).not.toBeInTheDocument();
  });
});
