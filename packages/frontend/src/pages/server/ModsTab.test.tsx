import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../App';
import { en } from '../../i18n';
import { FILTER_KEYS, isDependencyWarning, matchesFilter } from './ModsTab';
import { FakeSocket } from '../../test/fakes';
import { baseRoutes, mockApi, offline, serverFixture, type MockApi } from '../../test/mockApi';

const mod = (id: string, name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  serverId: 'srv-1',
  source: 'modrinth',
  projectId: `p-${id}`,
  versionId: 'v1',
  versionNumber: '1.0',
  name,
  fileName: `${id}.jar`,
  sha512: `h-${id}`,
  sizeBytes: 2048,
  isDependency: false,
  enabled: true,
  installedAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
  ...overrides,
});

const toggled = (target: Record<string, unknown>, enabled: boolean, extra: Record<string, unknown> = {}): { body: unknown } => ({
  body: { mod: { ...target, enabled }, changed: [{ ...target, enabled }], dependencies: [], warnings: [], ...extra },
});

let api: MockApi;
let mods: Array<Record<string, unknown>>;

function setup(options: { status?: Record<string, unknown> } = {}): void {
  const server = serverFixture(options.status === undefined ? {} : { status: options.status });
  mods = [mod('a', 'Alpha'), mod('b', 'Beta', { enabled: false }), mod('c', 'Gamma', { isDependency: true })];
  api = mockApi({
    ...baseRoutes(server),
    'GET /api/servers/srv-1/mods/backups': () => ({ body: { backups: [], totalBytes: 0, keep: 3 } }),
    'GET /api/servers/srv-1/mods': () => ({ body: { mods } }),
    'GET /api/modrinth': () => ({ body: { categories: [] } }),
  });
}

beforeEach(() => {
  FakeSocket.reset();
  vi.stubGlobal('WebSocket', FakeSocket);
  window.history.replaceState(null, '', '/servers/srv-1/mods');
});
afterEach(() => vi.unstubAllGlobals());

const row = async (name: string): Promise<HTMLElement> => {
  const item = (await screen.findByText(name)).closest('li');
  if (item === null) throw new Error(`no row for ${name}`);
  return item;
};

describe('filter helpers', () => {
  it('maps the three filter states', () => {
    expect(FILTER_KEYS.map((key) => en.mods.filter[key])).toEqual(['All', 'Enabled', 'Disabled']);
    expect(matchesFilter({ enabled: true }, 'all')).toBe(true);
    expect(matchesFilter({ enabled: false }, 'all')).toBe(true);
    expect(matchesFilter({ enabled: true }, 'enabled')).toBe(true);
    expect(matchesFilter({ enabled: false }, 'enabled')).toBe(false);
    expect(matchesFilter({ enabled: false }, 'disabled')).toBe(true);
    expect(matchesFilter({ enabled: true }, 'disabled')).toBe(false);
  });

  it('recognises the dependency warning in English (current backend) and in the older German wording', () => {
    expect(isDependencyWarning('“Gamma” was disabled and was also enabled as a required dependency.')).toBe(true);
    expect(isDependencyWarning('“Gamma” was disabled and is enabled again because “Alpha” needs it.')).toBe(false);
    expect(isDependencyWarning('trotzdem')).toBe(false);
  });
});

describe('mods tab with switches', () => {
  it('shows a switch per row, marks and dims switched-off mods, and filters', async () => {
    setup();
    const user = userEvent.setup();
    render(<App />);
    const beta = await row('Beta');
    expect(beta).toHaveAttribute('data-enabled', 'false');
    expect(within(beta).getByText('Disabled')).toBeInTheDocument();
    expect(within(beta).getByRole('switch', { name: 'Enable Beta' })).toHaveAttribute('aria-checked', 'false');
    expect(within(await row('Alpha')).getByRole('switch', { name: 'Disable Alpha' })).toHaveAttribute('aria-checked', 'true');
    // the text block of a disabled mod is dimmed
    expect(beta.querySelector('.opacity-60')).not.toBeNull();
    expect((await row('Alpha')).querySelector('.opacity-60')).toBeNull();

    await user.click(screen.getByRole('button', { name: /^Disabled\s*1$/ }));
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Enabled\s*2$/ }));
    expect(screen.queryByText('Beta')).not.toBeInTheDocument();
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Gamma')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^All\s*3$/ }));
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.getByText(/Switching is only possible while the server is stopped/)).toBeInTheDocument();
  });

  it('switches a mod off and reloads the list', async () => {
    setup();
    api.set('PATCH /api/servers/srv-1/mods/a', (call) => {
      mods[0] = { ...(mods[0] as object), enabled: (call.body as { enabled: boolean }).enabled };
      return toggled(mods[0] as Record<string, unknown>, (call.body as { enabled: boolean }).enabled);
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(within(await row('Alpha')).getByRole('switch', { name: 'Disable Alpha' }));
    expect(await screen.findByText('“Alpha” is now disabled')).toBeInTheDocument();
    expect(api.callsTo('PATCH /api/servers/srv-1/mods/a')[0]?.body).toEqual({ enabled: false });
    await waitFor(() => expect(within(screen.getByText('Alpha').closest('li') as HTMLElement).getByRole('switch', { name: 'Enable Alpha' })).toBeInTheDocument());
  });

  it('asks before switching off a mod others need, and repeats with force only after confirmation', async () => {
    setup();
    let attempts = 0;
    api.set('PATCH /api/servers/srv-1/mods/c', (call) => {
      attempts++;
      if ((call.body as { force?: boolean }).force !== true) {
        return { status: 409, body: { error: { code: 'MOD_REQUIRED_BY_OTHERS', message: 'is required', details: { dependents: [{ id: 'a', name: 'Alpha' }] } } } };
      }
      return toggled(mods[2] as Record<string, unknown>, false, { warnings: ['trotzdem'] });
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(within(await row('Gamma')).getByRole('switch', { name: 'Disable Gamma' }));
    const dialog = await screen.findByRole('dialog', { name: /Gamma.*still needed/ });
    expect(within(dialog).getByRole('list', { name: 'Affected entries' })).toHaveTextContent('Alpha');
    expect(attempts).toBe(1);
    await user.click(within(dialog).getByRole('button', { name: 'Disable anyway' }));
    expect(await screen.findByText('“Gamma” is now disabled')).toBeInTheDocument();
    expect(api.callsTo('PATCH /api/servers/srv-1/mods/c').map((call) => call.body)).toEqual([{ enabled: false }, { enabled: false, force: true }]);
  });

  it('reports the dependencies that were switched on together with a mod', async () => {
    setup();
    const beta = mods[1] as Record<string, unknown>;
    api.set('PATCH /api/servers/srv-1/mods/b', () => ({
      body: { mod: { ...beta, enabled: true }, changed: [{ ...beta, enabled: true }, mod('c', 'Gamma')], dependencies: [mod('c', 'Gamma')], warnings: ['“Gamma” was disabled and was also enabled as a required dependigkeit ebenfalls aktiviert.'] },
    }));
    const user = userEvent.setup();
    render(<App />);
    await user.click(within(await row('Beta')).getByRole('switch', { name: 'Enable Beta' }));
    const notice = await screen.findByText('“Beta” is now enabled');
    const box = notice.closest('[role="status"]') as HTMLElement;
    expect(within(box).getByRole('list', { name: 'Additionally enabled dependencies' })).toHaveTextContent('Gamma');
  });

  it('shows the error of a collision and leaves the switch where it was', async () => {
    setup();
    api.set('PATCH /api/servers/srv-1/mods/b', () => ({ status: 409, body: { error: { code: 'MOD_INCOMPATIBLE', message: '"Beta" is not compatible with "Alpha".', details: { mods: ['Beta', 'Alpha'] } } } }));
    const user = userEvent.setup();
    render(<App />);
    await user.click(within(await row('Beta')).getByRole('switch', { name: 'Enable Beta' }));
    expect(await screen.findByText('"Beta" is not compatible with "Alpha".')).toBeInTheDocument();
    expect(screen.getByText('Error code: MOD_INCOMPATIBLE')).toBeInTheDocument();
    expect(within(await row('Beta')).getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  });

  it('blocks the switches while the server runs', async () => {
    setup({ status: { ...offline, state: 'online', pid: 1, startedAt: Date.now(), port: 25565 } });
    render(<App />);
    expect(await within(await row('Alpha')).findByRole('switch')).toBeDisabled();
    expect(within(await row('Beta')).getByRole('switch')).toBeDisabled();
    expect(screen.getByText('Mods are locked while the server is running')).toBeInTheDocument();
  });

  it('shows the update backups with their size and cleans them up', async () => {
    setup();
    let cleaned = false;
    api.set('GET /api/servers/srv-1/mods/backups', () => ({
      body: {
        backups: cleaned
          ? [{ fileName: 'neu.jar', sizeBytes: 3000, createdAt: 1_700_000_000_000, modName: 'Alpha', logId: 2, removable: false }]
          : [
              { fileName: 'alt.jar', sizeBytes: 1_048_576, createdAt: 1_600_000_000_000, modName: 'Alpha', logId: 1, removable: true },
              { fileName: 'neu.jar', sizeBytes: 3000, createdAt: 1_700_000_000_000, modName: 'Alpha', logId: 2, removable: false },
            ],
        totalBytes: cleaned ? 3000 : 1_051_576,
        keep: 1,
      },
    }));
    api.set('POST /api/servers/srv-1/mods/backups/cleanup', () => {
      cleaned = true;
      return { body: { removed: 1, freedBytes: 1_048_576 } };
    });
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByLabelText('Total size of the update backups')).toHaveTextContent('2 files, 1 MB in total');
    expect(screen.getByLabelText('Total size of the update backups')).toHaveTextContent('1 file (1 MB) can be cleaned up');
    expect(screen.getByText('will be cleaned up')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clean up' }));
    expect(await screen.findByText('1 file removed, 1 MB freed.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Clean up' })).toBeDisabled());
  });
});
