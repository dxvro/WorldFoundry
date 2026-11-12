import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../App';
import { FakeSocket } from '../../test/fakes';
import { baseRoutes, mockApi, offline, serverFixture, type MockApi } from '../../test/mockApi';

const online = { ...offline, state: 'online', pid: 1, startedAt: Date.now() - 65 * 60_000, port: 25565, players: ['Alex', 'Steve'], rssBytes: 1024 * 1024 * 1024 };
const backups = {
  backups: [
    { id: 'b1', status: 'ok', kind: 'manual', createdAt: '2026-11-10T08:00:00.000Z', fileName: 'a.tar.gz', sizeBytes: 1, rawBytes: 1, includesConfig: false, levelName: 'world', worlds: ['world'], note: null, noteRef: null, error: null, errorRef: null, finishedAt: null, serverId: 'srv-1' },
  ],
  schedule: { mode: 'off', intervalHours: null, times: [], everyDays: 1, timeZone: 'UTC', keepLast: 7, includeConfig: false, nextRunAt: null },
  totalBytes: 1,
  freeBytes: null,
  running: false,
};

let api: MockApi;
beforeEach(() => {
  FakeSocket.reset();
  vi.stubGlobal('WebSocket', FakeSocket);
  window.history.replaceState(null, '', '/servers/srv-1');
});
afterEach(() => vi.unstubAllGlobals());

describe('the overview of a server', () => {
  it('opens first, with players, run time, memory, the last backup and the last console lines', async () => {
    api = mockApi({
      ...baseRoutes(serverFixture({ status: online })),
      'GET /api/servers/srv-1/console/history': () => ({ body: { lines: [{ seq: 1, time: 1, stream: 'stdout', text: '[Server] Alex joined the game' }] } }),
      'GET /api/servers/srv-1/backups': () => ({ body: backups }),
    });
    render(<App />);
    const region = await screen.findByRole('region', { name: 'Overview' });
    expect(within(screen.getByRole('navigation', { name: 'Server sections' })).getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
    expect(await within(region).findByText('[Server] Alex joined the game')).toBeInTheDocument();
    expect(within(region).getByText('Players').nextElementSibling).toHaveTextContent('2');
    expect(within(region).getByText('Running for').nextElementSibling).toHaveTextContent(/1 h/);
    expect(within(region).getByText('Memory').nextElementSibling).toHaveTextContent(/1(\.0)? GB of/);
    expect(within(region).getByText('Last backup').nextElementSibling).not.toHaveTextContent('None yet');
    expect(within(region).getByRole('link', { name: 'Open console' })).toHaveAttribute('href', '/servers/srv-1/console');
    expect(within(region).getByRole('link', { name: /Add a mod/ })).toHaveAttribute('href', '/servers/srv-1/mods');
  });

  it('keeps one main button and puts restart and force stop into the "…" menu', async () => {
    api = mockApi({ ...baseRoutes(serverFixture({ status: online })), 'POST /api/servers/srv-1/restart': () => ({ body: { status: online, warnings: [] } }) });
    const user = userEvent.setup();
    render(<App />);
    const header = (await screen.findByRole('heading', { name: 'Survival', level: 1 })).closest('header') as HTMLElement;
    expect(within(header).getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    expect(within(header).queryByRole('button', { name: 'Restart' })).not.toBeInTheDocument();
    await user.click(within(header).getByRole('button', { name: 'More actions' }));
    const menu = within(header).getByRole('menu', { name: 'More actions' });
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Restart', 'Force stop']);
    await user.click(within(menu).getByRole('menuitem', { name: 'Restart' }));
    await waitFor(() => expect(api.callsTo('POST /api/servers/srv-1/restart')).toHaveLength(1));
    expect(within(header).queryByRole('menu')).not.toBeInTheDocument();
  });
});
