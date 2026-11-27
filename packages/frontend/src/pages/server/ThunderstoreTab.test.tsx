import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../App';
import { FakeSocket } from '../../test/fakes';
import { baseRoutes, mockApi, offline, serverFixture, type MockApi } from '../../test/mockApi';

const valheimServer = (): Record<string, unknown> =>
  serverFixture({ game: 'valheim', name: 'Midgard', loader: 'vanilla', mcVersion: '', loaderVersion: null, port: 2456, gameSettings: JSON.stringify({ world: 'Dedicated', password: 'odin-rules', public: false, crossplay: false, queryPort: 2457 }), status: offline });

const epicLoot = { fullName: 'RandyKnapp-EpicLoot', name: 'EpicLoot', version: '0.16.0', dependency: false, requires: { 'denikson-BepInExPack_Valheim': '5.4.2360' } };
const bepinex = { fullName: 'denikson-BepInExPack_Valheim', name: 'BepInExPack Valheim', version: '5.4.2360', dependency: true, requires: {} };

let api: MockApi;
beforeEach(() => {
  FakeSocket.reset();
  vi.stubGlobal('WebSocket', FakeSocket);
  window.history.replaceState(null, '', '/servers/srv-1/thunderstore');
});
afterEach(() => vi.unstubAllGlobals());

describe('Thunderstore tab', () => {
  it('searches, marks the side a mod runs on and installs a mod with its dependencies', async () => {
    let installed = false;
    api = mockApi({
      ...baseRoutes(valheimServer()),
      'GET /api/servers/srv-1/thunderstore/mods': () => ({ body: { mods: installed ? [epicLoot, bepinex] : [], bepinex: installed } }),
      'GET /api/servers/srv-1/thunderstore/search': () => ({
        body: {
          hits: [
            { fullName: 'RandyKnapp-EpicLoot', name: 'EpicLoot', owner: 'RandyKnapp', summary: 'Loot and enchanting', icon: null, downloads: 2467576, serverSide: true, clientSide: true, installed },
            { fullName: 'RandyKnapp-EquipmentAndQuickSlots', name: 'EquipmentAndQuickSlots', owner: 'RandyKnapp', summary: 'Slots', icon: null, downloads: 1661047, serverSide: false, clientSide: true, installed: false },
          ],
          total: 2,
          offset: 0,
          limit: 20,
        },
      }),
      'POST /api/servers/srv-1/thunderstore/mods': () => {
        installed = true;
        return { status: 201, body: { installed: [epicLoot, bepinex] } };
      },
    });
    const user = userEvent.setup();
    render(<App />);
    const nav = await screen.findByRole('navigation', { name: /sections/i });
    expect(within(nav).getByRole('link', { name: 'Mods' })).toHaveAttribute('aria-current', 'page');
    expect(await screen.findByText('No mods installed yet.')).toBeInTheDocument();
    expect(screen.getByText(/BepInEx comes with the first mod/)).toBeInTheDocument();
    expect(await screen.findByText('Only for players: it does nothing on the server.')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Order'), 'newest');
    expect(api.callsTo('GET /api/servers/srv-1/thunderstore/search').at(-1)?.url).toContain('ordering=newest');

    await user.click(await screen.findByRole('button', { name: 'Install EpicLoot' }));
    expect(await screen.findByText('Installed: EpicLoot 0.16.0, BepInExPack Valheim 5.4.2360')).toBeInTheDocument();
    expect(api.callsTo('POST /api/servers/srv-1/thunderstore/mods').map((call) => call.body)).toEqual([{ fullName: 'RandyKnapp-EpicLoot' }]);
    const list = await screen.findByRole('list', { name: 'Installed mods' });
    expect(within(list).getByText('denikson-BepInExPack_Valheim 5.4.2360 · needed by other mods')).toBeInTheDocument();
    expect(screen.getByText(/BepInEx is installed/)).toBeInTheDocument();
  });
});
