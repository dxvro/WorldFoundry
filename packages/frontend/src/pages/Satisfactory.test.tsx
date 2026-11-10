import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { FakeSocket } from '../test/fakes';
import { baseRoutes, mockApi, offline, serverFixture, systemFixture, type MockApi } from '../test/mockApi';

const satisfactoryServer = (overrides: Record<string, unknown> = {}): Record<string, unknown> =>
  serverFixture({ game: 'satisfactory', name: 'Factory', loader: 'vanilla', mcVersion: '', loaderVersion: null, port: 7777, gameSettings: JSON.stringify({ branch: 'public', reliablePort: 8888 }), status: offline, ...overrides });

let api: MockApi;
beforeEach(() => {
  FakeSocket.reset();
  vi.stubGlobal('WebSocket', FakeSocket);
});
afterEach(() => vi.unstubAllGlobals());

describe('Satisfactory wizard', () => {
  it('creates the server with the chosen branch and warns about Windows', async () => {
    api = mockApi({
      ...baseRoutes(satisfactoryServer(), systemFixture({ platform: 'win32' })),
      'POST /api/servers': () => ({ status: 201, body: { server: satisfactoryServer({ installState: 'installing' }) } }),
      'GET /api/servers/srv-1/install-log': () => ({ body: { lines: [], totalLines: 0, truncated: false } }),
    });
    window.history.replaceState(null, '', '/new/satisfactory');
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'New Satisfactory server' })).toBeInTheDocument();
    expect(await screen.findByText(/stopping ends the process at once/)).toBeInTheDocument();
    expect(screen.getByText('Not an official Satisfactory product. Not approved by or associated with Coffee Stain Studios or Coffee Stain Publishing.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Server name'), 'Factory');
    await user.selectOptions(screen.getByLabelText('Steam branch'), 'experimental');
    await user.click(screen.getByRole('button', { name: 'Create and install' }));
    expect(api.callsTo('POST /api/servers').map((call) => call.body)).toEqual([{ game: 'satisfactory', name: 'Factory', branch: 'experimental' }]);
  });
});

describe('Satisfactory server page', () => {
  it('shows its ports and tabs and installs a ficsit.app mod', async () => {
    let installed = false;
    api = mockApi({
      ...baseRoutes(satisfactoryServer()),
      'GET /api/servers/srv-1/ficsit/mods': () => ({ body: { mods: installed ? [{ reference: 'RefinedPower', name: 'Refined Power', version: '2026.3.28', dependency: false, requires: { SML: '^3.11.0' } }, { reference: 'SML', name: 'Satisfactory Mod Loader', version: '3.12.0', dependency: true, requires: {} }] : [], gameBuild: 491200 } }),
      'GET /api/servers/srv-1/ficsit/search': () => ({ body: { hits: [{ reference: 'RefinedPower', name: 'Refined Power', summary: 'Power buildings', logo: null, downloads: 1500000, installed }], total: 1, offset: 0, limit: 20 } }),
      'POST /api/servers/srv-1/ficsit/mods': () => {
        installed = true;
        return { status: 201, body: { installed: [{ reference: 'RefinedPower', name: 'Refined Power', version: '2026.3.28', dependency: false, requires: {} }, { reference: 'SML', name: 'Satisfactory Mod Loader', version: '3.12.0', dependency: true, requires: {} }] } };
      },
    });
    window.history.replaceState(null, '', '/servers/srv-1/ficsit');
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Factory' })).toBeInTheDocument();
    expect(screen.getByText('Port 7777 (TCP+UDP), 8888 (TCP)')).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: /sections/i });
    expect(within(nav).getAllByRole('link').map((link) => link.textContent)).toEqual(['Console', 'Configuration', 'Settings files', 'Mods (ficsit.app)', 'Players', 'Backups']);

    expect(await screen.findByText('No mods installed yet.')).toBeInTheDocument();
    expect(screen.getByText('Game build 491200')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Install Refined Power' }));
    expect(await screen.findByText('Installed: Refined Power 2026.3.28, Satisfactory Mod Loader 3.12.0')).toBeInTheDocument();
    expect(api.callsTo('POST /api/servers/srv-1/ficsit/mods').map((call) => call.body)).toEqual([{ reference: 'RefinedPower' }]);
    const list = await screen.findByRole('list', { name: 'Installed mods' });
    expect(within(list).getByText('SML 3.12.0 · needed by other mods')).toBeInTheDocument();
  });

  it('explains how to claim the server', async () => {
    mockApi(baseRoutes(satisfactoryServer()));
    window.history.replaceState(null, '', '/servers/srv-1/config');
    render(<App />);
    expect(await screen.findByText(/Server Manager, add server/)).toBeInTheDocument();
  });
});
