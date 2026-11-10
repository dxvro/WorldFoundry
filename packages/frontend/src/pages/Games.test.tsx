import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { FakeSocket } from '../test/fakes';
import { baseRoutes, mockApi, offline, serverFixture, type MockApi } from '../test/mockApi';

const MINECRAFT = 'Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft.';
const ZOMBOID = 'Not an official Project Zomboid product. Not approved by or associated with The Indie Stone.';
const ARK = 'Not an official ARK product. Not approved by or associated with Studio Wildcard or Snail Games.';

let api: MockApi;
const open = (path: string, routes: Record<string, Parameters<MockApi['set']>[1]> = {}): void => {
  api = mockApi({
    ...baseRoutes(serverFixture({ status: offline })),
    'GET /api/servers/srv-1/console/history': () => ({ body: { lines: [] } }),
    'GET /api/loaders': () => ({ body: { loaders: [] } }),
    ...routes,
  });
  window.history.replaceState(null, '', path);
  render(<App />);
};

beforeEach(() => {
  FakeSocket.reset();
  vi.stubGlobal('WebSocket', FakeSocket);
});
afterEach(() => vi.unstubAllGlobals());

describe('games page', () => {
  it('lists every game with its disclaimer, rights holders, license and mod sources', async () => {
    open('/games');
    expect(await screen.findByRole('heading', { name: 'Games', level: 1 })).toBeInTheDocument();
    const cards = await screen.findAllByTestId('game-card');
    expect(cards).toHaveLength(4);

    const minecraft = within(cards[0] as HTMLElement);
    expect(minecraft.getByRole('heading', { name: 'Minecraft: Java Edition' })).toBeInTheDocument();
    expect(minecraft.getByText(MINECRAFT)).toBeInTheDocument();
    expect(minecraft.getByText('Available')).toBeInTheDocument();
    expect(minecraft.getByText('1 server')).toBeInTheDocument();
    expect(minecraft.getByText('Downloaded from the official source at installation')).toBeInTheDocument();
    expect(minecraft.getByText('Game: 25565 (TCP)')).toBeInTheDocument();
    expect(minecraft.getByRole('link', { name: 'Modrinth' })).toHaveAttribute('href', 'https://modrinth.com');
    // a source that needs a key says so: WorldFoundry ships none
    expect(minecraft.getByText('own API key needed')).toBeInTheDocument();
    expect(minecraft.getByText('In progress')).toBeInTheDocument();
    expect(minecraft.getByRole('link', { name: 'License of Minecraft: Java Edition' })).toHaveAttribute('rel', expect.stringContaining('noopener'));

    const zomboid = within(cards[1] as HTMLElement);
    expect(zomboid.getByText(ZOMBOID)).toBeInTheDocument();
    expect(zomboid.getByText('Downloaded with SteamCMD (app 1, anonymous login)')).toBeInTheDocument();
    expect(zomboid.getByRole('button', { name: 'Create a server' })).toBeInTheDocument();

    const ark = within(cards[3] as HTMLElement);
    expect(ark.getByText(ARK)).toBeInTheDocument();
    expect(ark.getByText('Planned')).toBeInTheDocument();
    expect(ark.queryByRole('button', { name: 'Create a server' })).not.toBeInTheDocument();

    expect(screen.getByRole('heading', { name: 'Trademarks and affiliation' })).toBeInTheDocument();
  });

  it('says so when the list cannot be loaded, and loads it again on request', async () => {
    const working = baseRoutes({})['GET /api/games'];
    open('/games', { 'GET /api/games': () => ({ status: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'boom' } } }) });
    expect(await screen.findByText('The list of games could not be loaded')).toBeInTheDocument();
    expect(screen.queryByTestId('game-card')).not.toBeInTheDocument();
    if (working !== undefined) api.set('GET /api/games', working);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findAllByTestId('game-card')).toHaveLength(4);
  });
});

describe('new server', () => {
  it('offers the available game as a link and shows the planned one without a link', async () => {
    open('/new');
    expect(await screen.findByRole('heading', { name: 'New server' })).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Games' });
    expect(within(list).getByRole('link', { name: /Minecraft: Java Edition/ })).toHaveAttribute('href', '/new/minecraft');
    expect(within(list).getByRole('link', { name: /Project Zomboid/ })).toHaveAttribute('href', '/new/zomboid');
    expect(within(list).queryByRole('link', { name: /ARK/ })).not.toBeInTheDocument();
    expect(within(list).getByText('ARK: Survival Evolved')).toBeInTheDocument();
    expect(within(list).getByText(ARK)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Minecraft server from an existing world' })).toHaveAttribute('href', '/new/world');
  });

  it('opens the wizard of the chosen game, with the disclaimer of that game', async () => {
    open('/new');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('link', { name: /Minecraft: Java Edition/ }));
    expect(await screen.findByLabelText('Server name')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/new/minecraft');
    expect(screen.getByText(MINECRAFT)).toBeInTheDocument();
  });
});

describe('servers and their game', () => {
  it('groups the overview by game', async () => {
    open('/');
    const group = await screen.findByRole('region', { name: 'Minecraft: Java Edition servers' });
    expect(within(group).getByRole('heading', { name: /Minecraft: Java Edition/ })).toBeInTheDocument();
    expect(within(group).getByText('Survival')).toBeInTheDocument();
  });

  it('shows the disclaimer of the game on the page of a server', async () => {
    open('/servers/srv-1');
    expect(await screen.findByRole('heading', { name: 'Survival' })).toBeInTheDocument();
    expect(await screen.findByText(MINECRAFT)).toBeInTheDocument();
  });
});

describe('mod store', () => {
  it('says that CurseForge is in progress', async () => {
    open('/servers/srv-1/store', {
      'GET /api/servers/srv-1/mods': () => ({ body: { mods: [] } }),
      'GET /api/servers/srv-1/mods/search': () => ({ body: { hits: [], total: 0, offset: 0, limit: 20 } }),
      'GET /api/modrinth/categories': () => ({ body: { categories: [] } }),
    });
    expect(await screen.findByText('CurseForge: in progress')).toBeInTheDocument();
    expect(screen.getByText(/Installing from CurseForge is being built/)).toBeInTheDocument();
  });
});
