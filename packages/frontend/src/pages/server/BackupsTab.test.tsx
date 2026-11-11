import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../App';
import { FakeSocket } from '../../test/fakes';
import { baseRoutes, mockApi, offline, serverFixture, type MockApi } from '../../test/mockApi';
import { intervalLabel, parseKeepLast } from './BackupsTab';

const backup = (id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  serverId: 'srv-1',
  kind: 'manual',
  status: 'ok',
  fileName: `${id}.tar.gz`,
  sizeBytes: 5 * 1024 * 1024,
  rawBytes: 9 * 1024 * 1024,
  includesConfig: false,
  levelName: 'world',
  worlds: ['world', 'world_nether'],
  note: null,
  error: null,
  createdAt: '2025-03-01T10:00:00.000Z',
  finishedAt: '2025-03-01T10:00:05.000Z',
  ...overrides,
});

const listBody = (backups: Array<Record<string, unknown>>, schedule = { intervalHours: null, keepLast: 7, includeConfig: false }): { body: unknown } => ({
  body: { backups, schedule, totalBytes: backups.reduce((sum, entry) => sum + Number(entry['sizeBytes']), 0), freeBytes: 50 * 1024 ** 3, running: false },
});

let api: MockApi;
let backups: Array<Record<string, unknown>>;

function setup(status: Record<string, unknown> = offline): void {
  backups = [backup('b1'), backup('b2', { kind: 'auto', createdAt: '2025-03-02T10:00:00.000Z' }), backup('b3', { kind: 'safety', status: 'failed', error: 'Nicht genug freier Speicherplatz', sizeBytes: 0 })];
  api = mockApi({
    ...baseRoutes(serverFixture({ status })),
    'GET /api/servers/srv-1/backups': () => listBody(backups),
  });
}

beforeEach(() => {
  FakeSocket.reset();
  vi.stubGlobal('WebSocket', FakeSocket);
  window.history.replaceState(null, '', '/servers/srv-1/backups');
});
afterEach(() => vi.unstubAllGlobals());

describe('helpers', () => {
  it('reads the keep-last field strictly', () => {
    expect(parseKeepLast('7')).toBe(7);
    expect(parseKeepLast(' 100 ')).toBe(100);
    for (const bad of ['0', '101', '-1', '1,5', 'abc', '', '1e2']) expect(parseKeepLast(bad)).toBeNull();
  });

  it('words the intervals', () => {
    expect([1, 6, 24, 168].map(intervalLabel)).toEqual(['Every hour', 'Every 6 hours', 'Every day', 'Every week']);
  });
});

describe('backups tab', () => {
  it('lists date, size, kind and status with the matching actions', async () => {
    setup();
    render(<App />);
    const rows = await screen.findAllByTestId('backup-row');
    expect(rows).toHaveLength(3);
    const manual = rows.find((entry) => within(entry).queryByText('Manual') !== null) as HTMLElement;
    expect(within(manual).getByText('Done')).toBeInTheDocument();
    expect(manual).toHaveTextContent('5 MB');
    expect(manual).toHaveTextContent('world, world_nether');
    const download = within(manual).getByRole('link', { name: /^Download backup/ });
    expect(download).toHaveAttribute('href', '/api/servers/srv-1/backups/b1/download');
    expect(within(manual).getByRole('button', { name: 'Restore' })).toBeEnabled();
    const failed = rows.find((entry) => within(entry).queryByText('Safety') !== null) as HTMLElement;
    expect(within(failed).getByText('Failed')).toBeInTheDocument();
    expect(failed).toHaveTextContent('Nicht genug freier Speicherplatz');
    expect(within(failed).queryByRole('link')).not.toBeInTheDocument();
    expect(within(failed).queryByRole('button', { name: 'Restore' })).not.toBeInTheDocument();
    expect(screen.getByText(/3 backups, 10 MB in total/)).toBeInTheDocument();
  });

  it('creates a backup and passes the config option', async () => {
    setup();
    api.set('POST /api/servers/srv-1/backups', () => ({ status: 202, body: { backup: backup('b4', { status: 'running' }) } }));
    const user = userEvent.setup();
    render(<App />);
    await screen.findAllByTestId('backup-row');
    await user.click(screen.getByRole('checkbox', { name: /Include configuration files/ }));
    await user.click(screen.getByRole('button', { name: 'Create backup' }));
    await waitFor(() => expect(api.callsTo('POST /api/servers/srv-1/backups')).toHaveLength(1));
    expect(api.callsTo('POST /api/servers/srv-1/backups')[0]?.body).toEqual({ includeConfig: true });
  });

  it('restores only after a confirmation that names the safety backup', async () => {
    setup();
    api.set('POST /api/servers/srv-1/backups/b1/restore', () => ({ body: { backup: backup('b1'), safety: backup('s1', { kind: 'safety' }), warnings: ['The world is called “world”, the server uses “other”.'] } }));
    const user = userEvent.setup();
    render(<App />);
    const rows = await screen.findAllByTestId('backup-row');
    const manual = rows.find((entry) => within(entry).queryByText('Manual') !== null) as HTMLElement;
    await user.click(within(manual).getByRole('button', { name: 'Restore' }));
    const dialog = await screen.findByRole('dialog', { name: 'Restore backup?' });
    expect(dialog).toHaveTextContent('safety backup');
    expect(api.callsTo('POST /api/servers/srv-1/backups/b1/restore')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Restore' }));
    expect(await screen.findByText('The backup was restored')).toBeInTheDocument();
    expect(screen.getByText(/uses “other”/)).toBeInTheDocument();
  });

  it('shows the backend error of a failed restore inside the dialog', async () => {
    setup();
    api.set('POST /api/servers/srv-1/backups/b1/restore', () => ({ status: 422, body: { error: { code: 'ARCHIVE_CORRUPT', message: 'The archive is damaged or incomplete.' } } }));
    const user = userEvent.setup();
    render(<App />);
    const rows = await screen.findAllByTestId('backup-row');
    await user.click(within(rows.find((entry) => within(entry).queryByText('Manual') !== null) as HTMLElement).getByRole('button', { name: 'Restore' }));
    const dialog = await screen.findByRole('dialog', { name: 'Restore backup?' });
    await user.click(within(dialog).getByRole('button', { name: 'Restore' }));
    expect(await within(dialog).findByText('The archive is damaged or incomplete.')).toBeInTheDocument();
  });

  it('deletes after confirmation', async () => {
    setup();
    api.set('DELETE /api/servers/srv-1/backups/b2', () => ({ body: { deleted: true } }));
    const user = userEvent.setup();
    render(<App />);
    const rows = await screen.findAllByTestId('backup-row');
    const auto = rows.find((entry) => within(entry).queryByText('Automatic') !== null) as HTMLElement;
    await user.click(within(auto).getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete backup?' });
    expect(api.callsTo('DELETE /api/servers/srv-1/backups/b2')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.callsTo('DELETE /api/servers/srv-1/backups/b2')).toHaveLength(1));
  });

  it('blocks restoring while the server runs and says that saving pauses briefly', async () => {
    setup({ ...offline, state: 'online', pid: 1, startedAt: Date.now(), port: 25565 });
    render(<App />);
    const rows = await screen.findAllByTestId('backup-row');
    const manual = rows.find((entry) => within(entry).queryByText('Manual') !== null) as HTMLElement;
    expect(within(manual).getByRole('button', { name: 'Restore' })).toBeDisabled();
    expect(screen.getByText(/saving pauses briefly/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create backup' })).toBeEnabled();
  });

  it('refuses to start a backup while the server starts or stops', async () => {
    setup({ ...offline, state: 'stopping', pid: 1, startedAt: Date.now(), port: 25565 });
    render(<App />);
    await screen.findAllByTestId('backup-row');
    expect(screen.getByRole('button', { name: 'Create backup' })).toBeDisabled();
  });

  it('saves the schedule and the retention', async () => {
    setup();
    api.set('PATCH /api/servers/srv-1/backups/schedule', (call) => ({ body: { schedule: { intervalHours: 6, keepLast: 3, includeConfig: false, ...(call.body as object) } } }));
    const user = userEvent.setup();
    render(<App />);
    await screen.findAllByTestId('backup-row');
    const save = screen.getByRole('button', { name: 'Save schedule' });
    expect(save).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('Automatic backup'), '6');
    const keep = screen.getByLabelText('Automatic backups to keep');
    await user.clear(keep);
    await user.type(keep, '3');
    await user.click(save);
    await waitFor(() => expect(api.callsTo('PATCH /api/servers/srv-1/backups/schedule')).toHaveLength(1));
    expect(api.callsTo('PATCH /api/servers/srv-1/backups/schedule')[0]?.body).toEqual({ intervalHours: 6, keepLast: 3 });
  });

  it('rejects a keep-last value outside 1 to 100 without calling the backend', async () => {
    setup();
    const user = userEvent.setup();
    render(<App />);
    await screen.findAllByTestId('backup-row');
    const keep = screen.getByLabelText('Automatic backups to keep');
    await user.clear(keep);
    await user.type(keep, '0');
    expect(await screen.findByText('Please enter a number from 1 to 100.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save schedule' })).toBeDisabled();
  });

  it('shows an empty state without backups', async () => {
    setup();
    backups.length = 0;
    render(<App />);
    expect(await screen.findByText(/No backups yet/)).toBeInTheDocument();
    expect(screen.getByText(/set a schedule below/)).toBeInTheDocument();
  });

  it('reads the list again when the backend reports a change', async () => {
    setup();
    render(<App />);
    await screen.findAllByTestId('backup-row');
    const before = api.callsTo('GET /api/servers/srv-1/backups').length;
    backups.push(backup('b9', { createdAt: '2025-04-01T10:00:00.000Z' }));
    FakeSocket.last.open();
    FakeSocket.last.receive({ type: 'backup.changed', serverId: 'srv-1', backupId: 'b9', kind: 'manual', status: 'ok', error: null });
    await waitFor(() => expect(api.callsTo('GET /api/servers/srv-1/backups').length).toBeGreaterThan(before));
    await waitFor(() => expect(screen.getAllByTestId('backup-row')).toHaveLength(4));
  });
});
