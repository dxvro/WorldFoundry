import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../App';
import { FakeSocket } from '../../test/fakes';
import { FakeXhr } from '../../test/fakeXhr';
import { baseRoutes, mockApi, serverFixture, type MockApi } from '../../test/mockApi';

const job = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'exp-1',
  serverId: 'srv-1',
  source: 'server',
  status: 'running',
  options: { format: 'zip', mods: 'jars', includeConfig: true },
  fileName: 'Survival-welt-2025-03-01.zip',
  sizeBytes: null,
  error: null,
  warnings: [],
  createdAt: 1,
  expiresAt: null,
  ...overrides,
});

const backup = {
  id: 'b1',
  serverId: 'srv-1',
  kind: 'manual',
  status: 'ok',
  fileName: 'b1.tar.gz',
  sizeBytes: 1024,
  rawBytes: 2048,
  includesConfig: false,
  levelName: 'world',
  worlds: ['world'],
  note: null,
  error: null,
  createdAt: '2025-03-01T10:00:00.000Z',
  finishedAt: '2025-03-01T10:00:05.000Z',
};

let api: MockApi;

function setup(status: Record<string, unknown> = {}): void {
  FakeXhr.install({ status: 202, body: {} });
  api = mockApi({
    ...baseRoutes(serverFixture(status === undefined ? {} : { status: { state: 'offline', pid: null, startedAt: null, exitCode: null, message: null, players: [], port: null, cpuPercent: null, rssBytes: null, ...status } })),
    'GET /api/servers/srv-1/backups': () => ({ body: { backups: [backup], schedule: { mode: 'off', intervalHours: null, times: [], everyDays: 1, timeZone: 'UTC', keepLast: 7, includeConfig: false, nextRunAt: null }, totalBytes: 1024, freeBytes: 1024 ** 3, running: false } }),
    'GET /api/imports/limits': () => ({ body: { maxUploadBytes: 4096 * 1024 * 1024 } }),
  });
}

beforeEach(() => {
  FakeSocket.reset();
  vi.stubGlobal('WebSocket', FakeSocket);
  window.history.replaceState(null, '', '/servers/srv-1/backups');
});
afterEach(() => vi.unstubAllGlobals());

describe('world export dialog', () => {
  it('sends the chosen options and offers the finished archive for download', async () => {
    setup();
    api.set('POST /api/servers/srv-1/exports', () => ({ status: 202, body: { export: job() } }));
    api.set('GET /api/exports/exp-1', () => ({ body: { export: job({ status: 'ready', sizeBytes: 3 * 1024 * 1024 }) } }));
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Export world' }));
    const dialog = await screen.findByRole('dialog', { name: 'Export world' });

    expect(within(dialog).getByRole('radio', { name: /ZIP \(recommended\)/ })).toBeChecked();
    await user.click(within(dialog).getByRole('radio', { name: /Mod list and mod files/ }));
    await user.click(within(dialog).getByRole('switch', { name: 'Include configuration' }));
    await user.click(within(dialog).getByRole('button', { name: 'Create export' }));

    await waitFor(() => expect(api.callsTo('POST /api/servers/srv-1/exports')).toHaveLength(1));
    expect(api.callsTo('POST /api/servers/srv-1/exports')[0]?.body).toEqual({ format: 'zip', mods: 'jars', includeConfig: true });
    const link = await within(dialog).findByRole('link', { name: 'Download' });
    expect(link).toHaveAttribute('href', '/api/exports/exp-1/download');
    expect(within(dialog).getByText(/Survival-welt-2025-03-01.zip, 3 MB/)).toBeInTheDocument();
  });

  it('reports a failed export and offers no download', async () => {
    setup();
    api.set('POST /api/servers/srv-1/exports', () => ({ status: 202, body: { export: job() } }));
    api.set('GET /api/exports/exp-1', () => ({ body: { export: job({ status: 'failed', error: 'Not enough free disk space for the export.' }) } }));
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Export world' }));
    const dialog = await screen.findByRole('dialog', { name: 'Export world' });
    await user.click(within(dialog).getByRole('button', { name: 'Create export' }));
    expect(await within(dialog).findByText('Not enough free disk space for the export.')).toBeInTheDocument();
    expect(within(dialog).queryByRole('link', { name: 'Download' })).toBeNull();
  });

  it('exports an existing backup as a world archive', async () => {
    setup();
    api.set('POST /api/servers/srv-1/backups/b1/export', () => ({ status: 202, body: { export: job({ source: 'backup', status: 'ready', sizeBytes: 1024 }) } }));
    api.set('GET /api/exports/exp-1', () => ({ body: { export: job({ source: 'backup', status: 'ready', sizeBytes: 1024 }) } }));
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Export as world' }));
    const dialog = await screen.findByRole('dialog', { name: 'Export backup as world' });
    await user.click(within(dialog).getByRole('button', { name: 'Create export' }));
    await waitFor(() => expect(api.callsTo('POST /api/servers/srv-1/backups/b1/export')).toHaveLength(1));
    expect(api.callsTo('POST /api/servers/srv-1/backups/b1/export')[0]?.body).toEqual({ format: 'zip' });
    expect(await within(dialog).findByRole('link', { name: 'Download' })).toBeInTheDocument();
  });
});

describe('replace world dialog', () => {
  const analysis = {
    archive: { format: 'zip', sizeBytes: 1024, entries: 3, uncompressedBytes: 2048 },
    source: 'world',
    world: { folderName: 'x', levelName: 'Neu', layout: 'inside', hasNether: true, hasEnd: false, otherWorlds: [], gameType: 0, hardcore: false, lastPlayed: null, singleplayerPlayer: false },
    version: { mcVersion: '1.21.1', approximate: false, dataVersion: 3955, preOneNine: false },
    proposal: { loader: 'vanilla', loaderVersion: null, mcVersion: '1.21.1', evidence: [] },
    modded: false,
    config: { properties: false, items: [] },
    mods: [],
    hasJars: false,
    manifest: null,
    notices: [],
  };
  const staged = { id: 'imp-9', mode: 'replace', serverId: 'srv-1', status: 'staged', phase: null, message: null, error: null, analysis, result: null, createdAt: 1, expiresAt: 2 };

  it('uploads for this server, shows the notices and replaces the world after the acknowledgement', async () => {
    setup();
    FakeXhr.install({ status: 202, body: { import: { ...staged, status: 'analyzing', analysis: null } } });
    let replaced = false;
    api.set('GET /api/imports/imp-9', () => ({ body: { import: replaced ? { ...staged, status: 'done', analysis: null, result: { serverId: 'srv-1', folders: ['world'], jarsPlaced: [], modsInstalled: [], modsFailed: [], safetyBackupId: 's1', warnings: [] } } : staged } }));
    api.set('POST /api/imports/imp-9/review', () => ({
      body: {
        notices: [{ code: 'REPLACE_ONE_WAY', level: 'info', needsConfirm: false, text: 'The current world is replaced by the imported one.' }, { code: 'WORLD_UPGRADE', level: 'warn', needsConfirm: true, text: 'Einweg-Umstellung.' }],
        matches: [],
        modrinthAvailable: true,
      },
    }));
    api.set('POST /api/servers/srv-1/world/replace', () => {
      replaced = true;
      return { status: 202, body: { import: { ...staged, status: 'applying' } } };
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Replace world' }));
    const dialog = await screen.findByRole('dialog', { name: 'Replace world' });
    await user.upload(dialog.querySelector('input[type="file"]') as HTMLInputElement, new File(['x'], 'neu.zip'));
    expect(FakeXhr.sent[0]?.url).toBe('/api/imports?serverId=srv-1');
    await within(dialog).findByTestId('analysis-facts');
    expect(await within(dialog).findByText('Einweg-Umstellung.')).toBeInTheDocument();

    const replaceButton = within(dialog).getByRole('button', { name: 'Replace world' });
    expect(replaceButton).toBeDisabled();
    await user.click(within(dialog).getByRole('checkbox', { name: 'Understood, continue anyway' }));
    await waitFor(() => expect(replaceButton).toBeEnabled());
    await user.click(replaceButton);

    await waitFor(() => expect(api.callsTo('POST /api/servers/srv-1/world/replace')).toHaveLength(1));
    expect(api.callsTo('POST /api/servers/srv-1/world/replace')[0]?.body).toEqual({ importId: 'imp-9', acknowledged: ['WORLD_UPGRADE'] });
    expect(await within(dialog).findByText('The world was replaced')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Replace world' })).toBeNull();
  });

  it('is not available while the server runs', async () => {
    setup({ state: 'online' });
    render(<App />);
    expect(await screen.findByRole('button', { name: 'Replace world' })).toBeDisabled();
  });
});
