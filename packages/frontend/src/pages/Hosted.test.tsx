import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { FakeSocket } from '../test/fakes';
import { baseRoutes, mockApi, offline, serverFixture, type MockApi } from '../test/mockApi';

let api: MockApi;
beforeEach(() => {
  FakeSocket.reset();
  vi.stubGlobal('WebSocket', FakeSocket);
});
afterEach(() => vi.unstubAllGlobals());

const valheim = (overrides: Record<string, unknown> = {}): Record<string, unknown> =>
  serverFixture({ game: 'valheim', loader: 'vanilla', mcVersion: '', loaderVersion: null, port: 2456, gameSettings: JSON.stringify({ world: 'Dedicated', password: 'secret1', public: false, crossplay: false, queryPort: 2457 }), status: offline, ...overrides });

describe('the newer games', () => {
  it('creates a Valheim server with the fields of the game', async () => {
    api = mockApi({
      ...baseRoutes(valheim()),
      'POST /api/servers': () => ({ status: 201, body: { server: valheim({ installState: 'installing' }) } }),
      'GET /api/servers/srv-1/install-log': () => ({ body: { lines: [], totalLines: 0, truncated: false } }),
    });
    window.history.replaceState(null, '', '/new/valheim');
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'New Valheim server' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Server name'), 'Midgard');
    await user.clear(screen.getByLabelText('World name'));
    await user.type(screen.getByLabelText('World name'), 'Yggdrasil');
    await user.type(screen.getByLabelText('Password'), 'odin-rules');
    await user.click(screen.getByRole('switch', { name: 'Show in the public server list' }));
    await user.click(screen.getByRole('button', { name: 'Create server' }));
    await waitFor(() => expect(api.callsTo('POST /api/servers')).toHaveLength(1));
    expect(api.callsTo('POST /api/servers')[0]?.body).toEqual({ game: 'valheim', name: 'Midgard', world: 'Yggdrasil', password: 'odin-rules', public: true, crossplay: false });
    expect(await screen.findByRole('heading', { name: /Survival/ })).toBeInTheDocument();
  });

  it('shows seed and size of 7 Days to Die only for random worlds', async () => {
    mockApi(baseRoutes(valheim()));
    window.history.replaceState(null, '', '/new/sevendays');
    const user = userEvent.setup();
    render(<App />);
    const world = await screen.findByLabelText('World');
    expect(screen.queryByLabelText('Seed (RWG)')).not.toBeInTheDocument();
    await user.selectOptions(world, 'RWG');
    expect(screen.getByLabelText('Seed (RWG)')).toHaveValue('WorldFoundry');
    expect(screen.getByLabelText('World size (RWG)')).toHaveValue('6144');
  });

  it('changes the game settings of a stopped server and only sends what changed', async () => {
    api = mockApi({ ...baseRoutes(valheim()), 'PATCH /api/servers/srv-1/game-settings': () => ({ body: { server: valheim() } }) });
    window.history.replaceState(null, '', '/servers/srv-1/config');
    const user = userEvent.setup();
    render(<App />);
    const world = await screen.findByLabelText('World name');
    expect(world).toHaveValue('Dedicated');
    await user.clear(world);
    await user.type(world, 'Niflheim');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(api.callsTo('PATCH /api/servers/srv-1/game-settings')).toHaveLength(1));
    expect(api.callsTo('PATCH /api/servers/srv-1/game-settings')[0]?.body).toEqual({ world: 'Niflheim' });
    expect(await screen.findByText('Saved. The change applies on the next start.')).toBeInTheDocument();
  });

  it('locks the game settings while the server runs', async () => {
    mockApi(baseRoutes(valheim({ status: { ...offline, state: 'online', pid: 1, startedAt: 1, port: 2456 } })));
    window.history.replaceState(null, '', '/servers/srv-1/config');
    render(<App />);
    expect(await screen.findByText('Stop the server to change these settings.')).toBeInTheDocument();
    expect(screen.getByLabelText('World name')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save settings' })).toBeDisabled();
  });

  it('keeps the CurseForge mod ids of ARK: Survival Ascended', async () => {
    const asa = serverFixture({ game: 'asa', loader: 'vanilla', mcVersion: '', loaderVersion: null, port: 7777, gameSettings: JSON.stringify({ map: 'TheIsland_WP', maxPlayers: 20, password: '', adminPassword: 'admin-pw-123', rconPort: 27020, mods: ['928793'] }), status: offline });
    api = mockApi({ ...baseRoutes(asa), 'PATCH /api/servers/srv-1/game-settings': () => ({ body: { server: asa } }) });
    window.history.replaceState(null, '', '/servers/srv-1/workshop');
    const user = userEvent.setup();
    render(<App />);
    const section = (await screen.findByRole('heading', { name: 'Mods (CurseForge)' })).closest('section') as HTMLElement;
    expect(within(section).getByText('928793')).toBeInTheDocument();
    await user.type(within(section).getByLabelText('CurseForge project id'), '900062');
    await user.click(within(section).getByRole('button', { name: 'Add mod' }));
    await waitFor(() => expect(api.callsTo('PATCH /api/servers/srv-1/game-settings')[0]?.body).toEqual({ mods: ['928793', '900062'] }));
    await user.type(within(section).getByLabelText('CurseForge project id'), 'abc');
    expect(within(section).getByText('A project id has digits only.')).toBeInTheDocument();
  });
});
