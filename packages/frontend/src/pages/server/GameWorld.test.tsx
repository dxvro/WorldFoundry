import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../App';
import { FakeSocket } from '../../test/fakes';
import { FakeXhr } from '../../test/fakeXhr';
import { baseRoutes, mockApi, offline, serverFixture, type MockApi } from '../../test/mockApi';

const emptyBackups = { backups: [], schedule: { intervalHours: null, keepLast: 7, includeConfig: false }, totalBytes: 0, freeBytes: null, running: false };
const satisfactory = (status: Record<string, unknown> = offline): Record<string, unknown> =>
  serverFixture({ game: 'satisfactory', loader: 'vanilla', mcVersion: '', loaderVersion: null, port: 7777, gameSettings: JSON.stringify({ branch: 'public', reliablePort: 8888 }), status });

let api: MockApi;
beforeEach(() => {
  FakeSocket.reset();
  vi.stubGlobal('WebSocket', FakeSocket);
});
afterEach(() => vi.unstubAllGlobals());

const open = (server: Record<string, unknown>): void => {
  api = mockApi({ ...baseRoutes(server), 'GET /api/servers/srv-1/backups': () => ({ body: emptyBackups }) });
  window.history.replaceState(null, '', '/servers/srv-1/backups');
  render(<App />);
};

describe('world import and export of a Steam game', () => {
  it('warns that the world is replaced, uploads the save and shows what happened', async () => {
    FakeXhr.install({ status: 200, body: { safety: { id: 'b0' }, warnings: ['1 save game(s) imported. The server loads the newest one: My.sav.'], warningRefs: [null], imported: { worlds: ['server'], configItems: [] } } });
    open(satisfactory());
    const user = userEvent.setup();
    const section = (await screen.findByRole('heading', { name: 'Import and export world' })).closest('section') as HTMLElement;
    expect(within(section).getByText(/save game \(\.sav\) straight from the game/)).toBeInTheDocument();
    const input = within(section).getByLabelText('Import world', { selector: 'input' });
    expect(input).toHaveAttribute('accept', '.sav,.zip,.tar.gz,.tgz');
    await user.upload(input, new File(['SAVE'], 'My.sav'));
    const dialog = await screen.findByRole('dialog', { name: 'Replace the world of this server?' });
    expect(within(dialog).getByText(/replaced by “My\.sav”.*safety backup/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Import world' }));
    expect(await screen.findByText('The world was imported')).toBeInTheDocument();
    expect(screen.getByText(/loads the newest one: My\.sav/)).toBeInTheDocument();
    expect(FakeXhr.sent).toEqual([expect.objectContaining({ method: 'POST', url: '/api/servers/srv-1/game-world/import?fileName=My.sav' })]);
  });

  it('offers export and import only while the server is stopped, and exports without the Minecraft options', async () => {
    open(satisfactory({ ...offline, state: 'online', pid: 1, startedAt: 1, port: 7777 }));
    const section = (await screen.findByRole('heading', { name: 'Import and export world' })).closest('section') as HTMLElement;
    expect(within(section).getByRole('button', { name: 'Export world' })).toBeDisabled();
    expect(within(section).getByRole('button', { name: 'Import world' })).toBeDisabled();
  });

  it('exports the save games of a stopped server', async () => {
    open(satisfactory());
    api.set('POST /api/servers/srv-1/exports', () => ({ status: 202, body: { export: { id: 'e1', status: 'ready', fileName: 'x.zip', sizeBytes: 10, warnings: [], warningRefs: [], error: null, errorRef: null } } }));
    api.set('GET /api/exports/e1', () => ({ body: { export: { id: 'e1', status: 'ready', fileName: 'x.zip', sizeBytes: 10, warnings: [], warningRefs: [], error: null, errorRef: null } } }));
    const user = userEvent.setup();
    const section = (await screen.findByRole('heading', { name: 'Import and export world' })).closest('section') as HTMLElement;
    await user.click(within(section).getByRole('button', { name: 'Export world' }));
    const dialog = await screen.findByRole('dialog', { name: 'Export world' });
    expect(within(dialog).getByText(/save games of this server/)).toBeInTheDocument();
    expect(within(dialog).queryByText('Mods')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Create export' }));
    await waitFor(() => expect(api.callsTo('POST /api/servers/srv-1/exports')[0]?.body).toEqual({ format: 'zip', mods: 'none', includeConfig: false }));
    expect(await within(dialog).findByRole('link', { name: 'Download' })).toHaveAttribute('href', '/api/exports/e1/download');
  });
});
