import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../App';
import { FakeSocket } from '../../test/fakes';
import { baseRoutes, mockApi, offline, serverFixture } from '../../test/mockApi';

const GAMES = [
  { game: 'zomboid', port: 16261, settings: { profile: 'knox', branch: 'public', udpPort: 16262, adminPassword: 'pw-123456' } },
  { game: 'satisfactory', port: 7777, settings: { branch: 'public', reliablePort: 8888 } },
  { game: 'ark', port: 7777, settings: { map: 'TheIsland', maxPlayers: 70, peerPort: 7778, queryPort: 27015, rconPort: 27020, adminPassword: 'pw-123456' } },
] as const;

beforeEach(() => {
  FakeSocket.reset();
  vi.stubGlobal('WebSocket', FakeSocket);
});
afterEach(() => vi.unstubAllGlobals());

describe('deleting a server of a Steam game', () => {
  for (const entry of GAMES) {
    it(`${entry.game}: warns that all data is lost and deletes only after both confirmations`, async () => {
      const api = mockApi({
        ...baseRoutes(serverFixture({ game: entry.game, loader: 'vanilla', mcVersion: '', loaderVersion: null, port: entry.port, gameSettings: JSON.stringify(entry.settings), status: offline })),
        'GET /api/servers/srv-1/backups': () => ({ body: { backups: [], schedule: { mode: 'off', intervalHours: null, times: [], everyDays: 1, timeZone: 'UTC', keepLast: 7, includeConfig: false, nextRunAt: null }, totalBytes: 0, freeBytes: null, running: false } }),
        'DELETE /api/servers/srv-1': () => ({ body: { deleted: true } }),
      });
      window.history.replaceState(null, '', '/servers/srv-1/config');
      const user = userEvent.setup();
      render(<App />);
      await user.click(await screen.findByRole('button', { name: 'Delete server …' }));
      const dialog = await screen.findByRole('dialog', { name: 'Delete server permanently?' });
      expect(within(dialog).getByText('Warning: all data of this server will be lost')).toBeInTheDocument();
      expect(within(dialog).getByText(/cannot be undone/)).toBeInTheDocument();
      const confirm = within(dialog).getByRole('button', { name: 'Delete server and all data' });
      await user.type(within(dialog).getByLabelText(/Type the name/), 'Survival');
      expect(confirm).toBeDisabled();
      await user.click(within(dialog).getByRole('checkbox', { name: /all data of this server will be lost/ }));
      expect(confirm).toBeEnabled();
      await user.click(confirm);
      await waitFor(() => expect(api.callsTo('DELETE /api/servers/srv-1')).toHaveLength(1));
    });
  }
});
