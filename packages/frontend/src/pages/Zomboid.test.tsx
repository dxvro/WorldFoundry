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

describe('Project Zomboid settings files', () => {
  it('edits a file as text and saves it', async () => {
    const files = [
      { key: 'ini', label: 'Server settings', description: 'Name, password', path: 'data/Server/knox.ini', format: 'ini', exists: true, sizeBytes: 20 },
      { key: 'sandbox', label: 'Sandbox settings', description: 'World rules', path: 'data/Server/knox_SandboxVars.lua', format: 'lua', exists: false, sizeBytes: 0 },
    ];
    api = mockApi({
      ...baseRoutes(zomboidServer()),
      'GET /api/servers/srv-1/config-files': () => ({ body: { files } }),
      'GET /api/servers/srv-1/config-files/ini': () => ({ body: { file: files[0], text: 'PublicName=Knox\n' } }),
      'GET /api/servers/srv-1/config-files/sandbox': () => ({ body: { file: files[1], text: '' } }),
      'PUT /api/servers/srv-1/config-files/ini': (call) => ({ body: { file: files[0], text: (call.body as { text: string }).text } }),
    });
    window.history.replaceState(null, '', '/servers/srv-1/files');
    const user = userEvent.setup();
    render(<App />);
    const editor = await screen.findByLabelText('Text of Server settings');
    await vi.waitFor(() => expect(editor).toHaveValue('PublicName=Knox\n'));
    expect(screen.getByText('data/Server/knox.ini')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save file' })).toBeDisabled();
    await user.clear(editor);
    await user.type(editor, 'PublicName=Louisville');
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save file' }));
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    expect(api.callsTo('PUT /api/servers/srv-1/config-files/ini').map((call) => call.body)).toEqual([{ text: 'PublicName=Louisville' }]);

    await user.click(screen.getByRole('tab', { name: 'Sandbox settings' }));
    expect(await screen.findByText(/This file does not exist yet/)).toBeInTheDocument();
  });

  it('is read-only while the server runs', async () => {
    mockApi({
      ...baseRoutes(zomboidServer({ status: { ...offline, state: 'online', pid: 1, startedAt: 1, port: 16261 } })),
      'GET /api/servers/srv-1/config-files': () => ({ body: { files: [{ key: 'ini', label: 'Server settings', description: '', path: 'data/Server/knox.ini', format: 'ini', exists: true, sizeBytes: 1 }] } }),
      'GET /api/servers/srv-1/config-files/ini': () => ({ body: { file: { key: 'ini' }, text: 'A=1\n' } }),
    });
    window.history.replaceState(null, '', '/servers/srv-1/files');
    render(<App />);
    expect(await screen.findByText(/Stop the server to change its settings files/)).toBeInTheDocument();
    expect(await screen.findByLabelText('Text of Server settings')).toHaveAttribute('readonly');
  });
});

describe('Project Zomboid Steam Workshop', () => {
  it('adds an item with its suggested mod id and map, orders the lists and saves them', async () => {
    const item = (id: string, title: string, modIds: string[], mapFolders: string[] = []) => ({ id, found: true, title, previewUrl: null, sizeBytes: 1024, updatedAt: 1, modIds, mapFolders, forZomboid: true });
    api = mockApi({
      ...baseRoutes(zomboidServer()),
      'GET /api/servers/srv-1/workshop': () => ({ body: { items: [item('111', 'Brita', ['Brita'])], mods: ['Brita'], maps: ['Muldraugh, KY'], detailsError: null } }),
      'GET /api/workshop/lookup': () => ({ body: { item: item('222', 'Raven Creek', ['RavenCreek'], ['RavenCreek']) } }),
      'PUT /api/servers/srv-1/workshop': (call) => {
        const body = call.body as { items: string[]; mods: string[]; maps: string[] };
        return { body: { items: body.items.map((id) => item(id, id === '111' ? 'Brita' : 'Raven Creek', [])), mods: body.mods, maps: body.maps, detailsError: null } };
      },
    });
    window.history.replaceState(null, '', '/servers/srv-1/workshop');
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByText('Brita', { selector: 'p' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Workshop id or link'), 'https://steamcommunity.com/sharedfiles/filedetails/?id=222');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('Raven Creek', { selector: 'p' })).toBeInTheDocument();
    expect(api.callsTo('GET /api/workshop/lookup')[0]?.url).toContain('q=https%3A%2F%2Fsteamcommunity.com');
    const mods = screen.getByRole('list', { name: 'Mod ids' });
    expect(within(mods).getAllByRole('listitem').map((row) => row.textContent)).toEqual(['Brita', 'RavenCreek']);
    await user.click(screen.getByRole('button', { name: 'Move Raven Creek up' }));
    await user.click(screen.getByRole('button', { name: 'Save lists' }));
    expect(await screen.findByText(/The server downloads the items on its next start/)).toBeInTheDocument();
    expect(api.callsTo('PUT /api/servers/srv-1/workshop').map((call) => call.body)).toEqual([{ items: ['222', '111'], mods: ['Brita', 'RavenCreek'], maps: ['RavenCreek', 'Muldraugh, KY'] }]);
  });
});

describe('Project Zomboid backups', () => {
  it('offers backups without the Minecraft options and only while stopped', async () => {
    mockApi({
      ...baseRoutes(zomboidServer({ status: { ...offline, state: 'online', pid: 1, startedAt: 1, port: 16261 } })),
      'GET /api/servers/srv-1/backups': () => ({ body: { backups: [], schedule: { mode: 'off', intervalHours: null, times: [], everyDays: 1, timeZone: 'UTC', keepLast: 7, includeConfig: false, nextRunAt: null }, totalBytes: 0, freeBytes: null, running: false } }),
    });
    window.history.replaceState(null, '', '/servers/srv-1/backups');
    render(<App />);
    expect(await screen.findByText(/backed up while the server is stopped/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create backup' })).toBeDisabled();
    expect(screen.queryByText(/Include configuration files/)).not.toBeInTheDocument();
  });
});

describe('Project Zomboid players', () => {
  it('lists online players, sends a kick at once and asks before a ban', async () => {
    const online = { ...offline, state: 'online', pid: 1, startedAt: 1, port: 16261, players: ['Rick'] };
    api = mockApi({
      ...baseRoutes(zomboidServer({ status: online })),
      'GET /api/servers/srv-1/game-players': () => ({
        body: {
          online: ['Rick'],
          count: null,
          running: true,
          actions: [
            { id: 'kick', label: 'Kick', confirm: false },
            { id: 'ban', label: 'Ban', confirm: true },
          ],
        },
      }),
      'POST /api/servers/srv-1/game-players/kick': () => ({ body: { sent: 'kickuser "Rick"' } }),
      'POST /api/servers/srv-1/game-players/ban': () => ({ body: { sent: 'banuser "Negan"' } }),
    });
    window.history.replaceState(null, '', '/servers/srv-1/players');
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Kick Rick' }));
    expect(await screen.findByText('Sent: kickuser "Rick"')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Player name'), 'Negan');
    await user.click(within(screen.getByRole('region', { name: 'Player by name' })).getByRole('button', { name: 'Ban' }));
    const dialog = await screen.findByRole('dialog', { name: 'Ban: Negan?' });
    expect(api.callsTo('POST /api/servers/srv-1/game-players/ban')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Ban' }));
    expect(await screen.findByText('Sent: banuser "Negan"')).toBeInTheDocument();
    expect(api.callsTo('POST /api/servers/srv-1/game-players/ban').map((call) => call.body)).toEqual([{ name: 'Negan' }]);
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
    expect(screen.getByText('Join localhost:16261')).toHaveAttribute('title', 'UDP 16261 and 16262');
    const nav = screen.getByRole('navigation', { name: /sections/i });
    expect(within(nav).getAllByRole('link').map((link) => link.textContent)).toEqual(['Overview', 'Console', 'Players', 'Mods', 'World & backups', 'Settings']);
    expect(within(screen.getByRole('navigation', { name: 'Parts of Settings' })).getAllByRole('link').map((link) => link.textContent)).toEqual(['General', 'Settings files']);

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
    const table = await screen.findByRole('table', { name: 'Servers' });
    const row = within(table).getByRole('link', { name: /Survival/ }).closest('tr') as HTMLElement;
    expect(within(row).getByText('Project Zomboid')).toBeInTheDocument();
    expect(within(row).queryByText(/Minecraft/)).not.toBeInTheDocument();
  });
});
