import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { FakeSocket } from '../test/fakes';
import { baseRoutes, mockApi, offline, serverFixture } from '../test/mockApi';

const GB = 1024 ** 3;
const survival = serverFixture({ id: 'srv-1', name: 'Survival' });
const creative = serverFixture({ id: 'srv-2', name: 'Creative', status: { ...offline, state: 'crashed', exitCode: 1 } });

function setup(routes: Record<string, Parameters<typeof mockApi>[0][string]> = {}): ReturnType<typeof mockApi> {
  return mockApi({
    ...baseRoutes(survival),
    'GET /api/servers': () => ({ body: { servers: [survival, creative] } }),
    'GET /api/system/disk': () => ({ body: { totalBytes: 100 * GB, freeBytes: 40 * GB, backups: [{ serverId: 'srv-1', bytes: 30 * GB, count: 2 }] } }),
    ...routes,
  });
}

describe('AppShell', () => {
  beforeEach(() => {
    FakeSocket.reset();
    vi.stubGlobal('WebSocket', FakeSocket);
    window.localStorage.clear();
    delete document.documentElement.dataset.theme;
    window.history.replaceState(null, '', '/');
  });
  afterEach(() => vi.unstubAllGlobals());

  it('lists the servers under a collapsible entry and counts the ones that need attention', async () => {
    setup();
    const user = userEvent.setup();
    render(<App />);
    const nav = await screen.findByRole('navigation', { name: 'Main navigation' });
    expect(await within(nav).findByRole('link', { name: 'Creative' })).toBeInTheDocument();
    const toggle = within(nav).getByRole('button', { name: /Servers/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(within(toggle).getByText('1 server needs attention')).toBeInTheDocument();

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(within(nav).queryByRole('link', { name: 'Creative' })).not.toBeInTheDocument();
  });

  it('hides the sidebar with the menu button and remembers it', async () => {
    setup();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('navigation', { name: 'Main navigation' });
    const menu = screen.getByRole('button', { name: 'Show or hide the menu' });
    expect(menu).toHaveAttribute('aria-expanded', 'true');

    await user.click(menu);
    expect(menu).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('navigation', { name: 'Main navigation' })).not.toBeInTheDocument();
    expect(window.localStorage.getItem('worldfoundry.sidebar.collapsed')).toBe('1');
    // the disclaimer moves to the foot of the page
    expect(screen.getByText(/independent open-source project/)).toBeInTheDocument();
  });

  it('finds a server in the search and opens it', async () => {
    setup();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('link', { name: 'Creative' });
    const search = screen.getByRole('combobox', { name: 'Search' });
    await user.type(search, 'crea');
    const options = within(screen.getByRole('listbox', { name: 'Search results' })).getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual(['CreativeMinecraft: Java Edition']);

    await user.keyboard('{Enter}');
    await waitFor(() => expect(window.location.pathname).toBe('/servers/srv-2'));
    expect(search).toHaveValue('');
  });

  it('says so when the search finds nothing', async () => {
    setup();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('link', { name: 'Creative' });
    await user.type(screen.getByRole('combobox', { name: 'Search' }), 'zzz');
    expect(screen.getByText('Nothing found')).toBeInTheDocument();
  });

  it('switches to the light theme and keeps the choice', async () => {
    setup();
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Switch to the light theme' }));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(window.localStorage.getItem('worldfoundry.theme')).toBe('light');
    expect(screen.getByRole('button', { name: 'Switch to the dark theme' })).toBeInTheDocument();
  });

  it('lists what needs attention behind the bell', async () => {
    setup();
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Notifications (1)' }));
    await user.click(screen.getByRole('link', { name: 'Creative crashed' }));
    await waitFor(() => expect(window.location.pathname).toBe('/servers/srv-2'));
  });

  it('shows the free disk space and where it can be freed', async () => {
    setup();
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByText('40 GB of 100 GB')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Disk space used' })).toHaveAttribute('aria-valuenow', '60');

    await user.click(screen.getByRole('button', { name: 'Free up space' }));
    const dialog = screen.getByRole('dialog', { name: 'Free up space' });
    const link = within(dialog).getByRole('link', { name: /Survival/ });
    expect(link).toHaveTextContent('2 backups');
    expect(link).toHaveTextContent('30 GB');
    expect(link).toHaveAttribute('href', '/servers/srv-1/backups');
  });

  it('leaves the disk block out when the host cannot tell the size', async () => {
    setup({ 'GET /api/system/disk': () => ({ body: { totalBytes: null, freeBytes: null, backups: [] } }) });
    render(<App />);
    await screen.findByRole('link', { name: 'Creative' });
    expect(screen.queryByText('Space left')).not.toBeInTheDocument();
  });
});

describe('Overview cards', () => {
  beforeEach(() => {
    FakeSocket.reset();
    vi.stubGlobal('WebSocket', FakeSocket);
    window.localStorage.clear();
    window.history.replaceState(null, '', '/');
  });
  afterEach(() => vi.unstubAllGlobals());

  const names = (): string[] => within(screen.getByRole('list', { name: 'Servers' })).getAllByTestId('server-card').map((card) => within(card).getAllByRole('link')[0]?.textContent ?? '');

  it('sums up the servers, sorts them and filters by state', async () => {
    setup();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('list', { name: 'Servers' });
    expect(screen.getByText('Servers', { selector: 'dt' }).nextElementSibling).toHaveTextContent('2');
    expect(screen.getByText('Showing 2 of 2 servers')).toBeInTheDocument();
    expect(names()).toHaveLength(2);

    await user.selectOptions(screen.getByLabelText('Sort by'), 'name');
    expect(names()[0]).toContain('Creative');

    const filters = screen.getByRole('group', { name: 'Filter servers' });
    await user.click(within(filters).getByRole('button', { name: /^Running/ }));
    expect(within(filters).getByRole('button', { name: /^Running/ })).toHaveAttribute('aria-pressed', 'true');
    const running = screen.queryAllByTestId('server-card').length;
    await user.click(within(filters).getByRole('button', { name: /^Stopped/ }));
    expect(running + screen.queryAllByTestId('server-card').length).toBe(2);
  });
});
