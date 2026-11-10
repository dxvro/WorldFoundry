import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { FakeSocket } from '../test/fakes';
import { baseRoutes, mockApi, offline, serverFixture, systemFixture, type MockApi } from '../test/mockApi';

const settings = { profile: 'knox', branch: 'public', udpPort: 16262, adminPassword: 'secret-admin-pw' };
const zomboidServer = (overrides: Record<string, unknown> = {}): Record<string, unknown> =>
  serverFixture({ game: 'zomboid', loader: 'vanilla', mcVersion: '', loaderVersion: null, port: 16261, maxRamMb: 4096, gameSettings: JSON.stringify(settings), status: offline, ...overrides });

let api: MockApi;
beforeEach(() => {
  FakeSocket.reset();
  vi.stubGlobal('WebSocket', FakeSocket);
});
afterEach(() => vi.unstubAllGlobals());

describe('Project Zomboid wizard', () => {
  it('creates the server with the game, profile, branch and memory', async () => {
    api = mockApi({
      ...baseRoutes(zomboidServer(), systemFixture({ totalMemoryMb: 16384, platform: 'linux' })),
      'POST /api/servers': () => ({ status: 201, body: { server: zomboidServer({ installState: 'installing' }) } }),
      'GET /api/servers/srv-1/install-log': () => ({ body: { lines: [], totalLines: 0, truncated: false } }),
    });
    window.history.replaceState(null, '', '/new/zomboid');
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'New Project Zomboid server' })).toBeInTheDocument();
    expect(await screen.findByText(/sudo apt install lib32gcc-s1/)).toBeInTheDocument();
    expect(screen.getByText('Not an official Project Zomboid product. Not approved by or associated with The Indie Stone.')).toBeInTheDocument();

    const create = screen.getByRole('button', { name: 'Create and install' });
    expect(create).toBeDisabled();
    await user.type(screen.getByLabelText('Server name'), 'Knox');
    const profile = screen.getByLabelText('Profile name');
    await user.clear(profile);
    await user.type(profile, 'bad name');
    expect(screen.getByText('Letters, digits, _ and - only, at most 64 characters.')).toBeInTheDocument();
    expect(create).toBeDisabled();
    await user.clear(profile);
    await user.type(profile, 'knox');
    await user.click(create);

    expect(api.callsTo('POST /api/servers').map((call) => call.body)).toEqual([{ game: 'zomboid', name: 'Knox', profile: 'knox', branch: 'public', maxRamMb: 4096 }]);
    expect(await screen.findByRole('heading', { name: /^“Survival”/ })).toBeInTheDocument();
  });
});

describe('Project Zomboid server page', () => {
  it('has the console and its own settings only, with the ports and the hidden admin password', async () => {
    api = mockApi({
      ...baseRoutes(zomboidServer()),
      'GET /api/servers/srv-1/console/history': () => ({ body: { lines: [] } }),
      'PATCH /api/servers/srv-1': () => ({ body: { server: zomboidServer({ maxRamMb: 4096, autoStart: true }), restartRequired: false } }),
    });
    window.history.replaceState(null, '', '/servers/srv-1/config');
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Survival' })).toBeInTheDocument();
    expect(screen.getByText('Steam branch public')).toBeInTheDocument();
    expect(screen.getByText('UDP 16261 and 16262')).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: /sections/i });
    expect(within(nav).getAllByRole('link').map((link) => link.textContent)).toEqual(['Console', 'Configuration']);

    expect(screen.getByText('data/Server/knox.ini')).toBeInTheDocument();
    expect(screen.queryByText('secret-admin-pw')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show' }));
    expect(screen.getByText('secret-admin-pw')).toBeInTheDocument();

    await user.click(screen.getByRole('switch', { name: 'Start with WorldFoundry' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved. The change applies on the next start.')).toBeInTheDocument();
    expect(api.callsTo('PATCH /api/servers/srv-1').map((call) => call.body)).toEqual([{ maxRamMb: 4096, minRamMb: 1024, autoStart: true }]);
  });

  it('shows the game in the overview instead of a Minecraft version', async () => {
    mockApi(baseRoutes(zomboidServer()));
    window.history.replaceState(null, '', '/');
    render(<App />);
    const group = await screen.findByRole('region', { name: 'Project Zomboid servers' });
    expect(within(group).getByText('Survival')).toBeInTheDocument();
    expect(within(group).queryByText(/Minecraft/)).not.toBeInTheDocument();
  });
});
