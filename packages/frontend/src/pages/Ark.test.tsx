import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { FakeSocket } from '../test/fakes';
import { baseRoutes, mockApi, offline, serverFixture, type MockApi } from '../test/mockApi';

const settings = { map: 'Ragnarok', maxPlayers: 70, peerPort: 7778, queryPort: 27015, rconPort: 27020, adminPassword: 'ark-admin-pw' };
const arkServer = (overrides: Record<string, unknown> = {}): Record<string, unknown> =>
  serverFixture({ game: 'ark', name: 'Dino Land', loader: 'vanilla', mcVersion: '', loaderVersion: null, port: 7777, gameSettings: JSON.stringify(settings), status: offline, ...overrides });
const mod = (id: string, title: string) => ({ id, found: true, title, previewUrl: null, sizeBytes: 2048, updatedAt: 1, modIds: [], mapFolders: [], forZomboid: false, appId: 346110 });

let api: MockApi;
beforeEach(() => {
  FakeSocket.reset();
  vi.stubGlobal('WebSocket', FakeSocket);
});
afterEach(() => vi.unstubAllGlobals());

describe('ARK wizard', () => {
  it('creates the server with map and player limit and refuses names that break the command line', async () => {
    api = mockApi({
      ...baseRoutes(arkServer()),
      'POST /api/servers': () => ({ status: 201, body: { server: arkServer({ installState: 'installing' }) } }),
      'GET /api/servers/srv-1/install-log': () => ({ body: { lines: [], totalLines: 0, truncated: false } }),
    });
    window.history.replaceState(null, '', '/new/ark');
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'New ARK: Survival Evolved server' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Session name'), 'Dino?Land');
    expect(screen.getByText('No ?, quotes or backslashes, at most 60 characters.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create and install' })).toBeDisabled();
    await user.clear(screen.getByLabelText('Session name'));
    await user.type(screen.getByLabelText('Session name'), 'Dino Land');
    await user.selectOptions(screen.getByLabelText('Map'), 'Ragnarok');
    const limit = screen.getByLabelText('Player limit');
    await user.clear(limit);
    await user.type(limit, '20');
    await user.click(screen.getByRole('button', { name: 'Create and install' }));
    expect(api.callsTo('POST /api/servers').map((call) => call.body)).toEqual([{ game: 'ark', name: 'Dino Land', map: 'Ragnarok', maxPlayers: 20 }]);
  });
});

describe('ARK server page', () => {
  it('shows map, ports and the hidden admin password', async () => {
    mockApi(baseRoutes(arkServer()));
    window.history.replaceState(null, '', '/servers/srv-1/config');
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Dino Land' })).toBeInTheDocument();
    expect(screen.getByText('Map Ragnarok')).toBeInTheDocument();
    expect(screen.getByText('game 7777 UDP, peer 7778 UDP, query 27015 UDP, RCON 27020 TCP')).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: /sections/i });
    expect(within(nav).getAllByRole('link').map((link) => link.textContent)).toEqual(['Console', 'Configuration', 'Settings files', 'Steam Workshop', 'Players', 'Backups']);
    expect(screen.queryByText('ark-admin-pw')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show' }));
    expect(screen.getByText('ark-admin-pw')).toBeInTheDocument();
  });

  it('adds Workshop mods, orders them and saves', async () => {
    api = mockApi({
      ...baseRoutes(arkServer()),
      'GET /api/servers/srv-1/ark-mods': () => ({ body: { mods: [mod('731604991', 'Structures Plus')], detailsError: null } }),
      'GET /api/ark/workshop/lookup': () => ({ body: { item: mod('1404697612', 'Awesome Spyglass') } }),
      'PUT /api/servers/srv-1/ark-mods': (call) => ({ body: { mods: (call.body as { mods: string[] }).mods.map((id) => mod(id, id)), detailsError: null } }),
    });
    window.history.replaceState(null, '', '/servers/srv-1/workshop');
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByText('Structures Plus')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Workshop id or link'), '1404697612');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('Awesome Spyglass')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Move Awesome Spyglass up' }));
    await user.click(screen.getByRole('button', { name: 'Save mods' }));
    expect(await screen.findByText(/loads the mods on its next start/)).toBeInTheDocument();
    expect(api.callsTo('PUT /api/servers/srv-1/ark-mods').map((call) => call.body)).toEqual([{ mods: ['1404697612', '731604991'] }]);
  });
});
