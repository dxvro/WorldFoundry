import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../App';
import { FakeSocket } from '../../test/fakes';
import { baseRoutes, mockApi, serverFixture, systemFixture, type MockApi } from '../../test/mockApi';

const managedRuntime = {
  path: 'C:/data/runtimes/temurin-21/bin/java.exe',
  major: 21,
  version: '21.0.13',
  name: 'Eclipse Temurin 21.0.13+9-LTS (JRE)',
  source: 'managed',
  origin: 'Installed automatically by WorldFoundry on 11/5/2026: Eclipse Temurin 21.0.13+9-LTS (JRE), downloaded from api.adoptium.net, SHA-256 675c6158fd374747 verified.',
};
const systemJava = { path: 'C:/Program Files/Java/jdk-17/bin/java.exe', major: 17, version: '17.0.9', name: 'JDK', source: 'standard', origin: null };
const managedInfo = (inUseBy: string[] = []): Record<string, unknown> => ({
  major: 21,
  version: '21.0.13+9-LTS',
  release: 'jdk-21.0.13+9',
  image: 'jre',
  sha256: 'a'.repeat(64),
  installedAt: Date.UTC(2026, 10, 5),
  sizeBytes: 150 * 1024 * 1024,
  javaPath: managedRuntime.path,
  origin: managedRuntime.origin,
  inUseBy,
});

let api: MockApi;

function setup(system: Record<string, unknown>, server: Record<string, unknown> = serverFixture()): void {
  api = mockApi({
    ...baseRoutes(server, system),
    'GET /api/servers/srv-1/properties': () => ({ body: { exists: false, properties: { 'server-port': 25565, gamemode: 'survival', difficulty: 'easy', 'white-list': false, 'max-players': 20, 'view-distance': 10, 'online-mode': true, motd: 'x' }, extra: {} } }),
    'GET /api/servers/srv-1/backups': () => ({ body: { backups: [], schedule: { mode: 'off', intervalHours: null, times: [], everyDays: 1, timeZone: 'UTC', keepLast: 7, includeConfig: false, nextRunAt: null }, totalBytes: 0, freeBytes: null, running: false } }),
  });
}

beforeEach(() => {
  FakeSocket.reset();
  vi.stubGlobal('WebSocket', FakeSocket);
  window.history.replaceState(null, '', '/servers/srv-1/config');
});
afterEach(() => vi.unstubAllGlobals());

const runtimesSection = async (): Promise<HTMLElement> => {
  const heading = await screen.findByRole('heading', { name: 'Java runtimes' });
  return heading.closest('section') as HTMLElement;
};

describe('runtime list', () => {
  it('shows the origin of managed runtimes next to the others', async () => {
    setup(systemFixture({ javaRuntimes: [managedRuntime, systemJava], managedJava: [managedInfo()] }));
    render(<App />);
    const section = await runtimesSection();
    const items = within(section).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Java 21');
    expect(items[0]).toHaveTextContent('Installed by WorldFoundry');
    expect(items[0]).toHaveTextContent('JRE');
    expect(items[0]).toHaveTextContent('150 MB');
    expect(items[0]).toHaveTextContent('downloaded from api.adoptium.net');
    expect(items[0]).toHaveTextContent('C:/data/runtimes/temurin-21/bin/java.exe');
    expect(items[1]).toHaveTextContent('Standard installation folder');
    expect(within(items[1] as HTMLElement).queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
    expect(within(section).getByText(/If a server lacks the matching Java version, WorldFoundry installs it itself/)).toBeInTheDocument();
  });

  it('removes a managed runtime after confirmation', async () => {
    setup(systemFixture({ javaRuntimes: [managedRuntime], managedJava: [managedInfo()] }));
    api.set('DELETE /api/java/runtimes/21', () => ({ body: { removed: true } }));
    const user = userEvent.setup();
    render(<App />);
    const section = await runtimesSection();
    await user.click(within(section).getByRole('button', { name: 'Remove' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove Java 21?' });
    expect(api.callsTo('DELETE /api/java/runtimes/21')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.callsTo('DELETE /api/java/runtimes/21')).toHaveLength(1));
    expect(await screen.findByText('Java 21 was removed.')).toBeInTheDocument();
  });

  it('keeps the remove button disabled while a server uses the runtime and says which', async () => {
    setup(systemFixture({ javaRuntimes: [managedRuntime], managedJava: [managedInfo(['srv-1'])] }));
    render(<App />);
    const section = await runtimesSection();
    expect(within(section).getByRole('button', { name: 'Remove' })).toBeDisabled();
    expect(within(section).getByText(/Currently used by: Survival/)).toBeInTheDocument();
  });

  it('installs a runtime by hand and offers the one this server needs first', async () => {
    setup(systemFixture({ javaRuntimes: [] }));
    api.set('POST /api/java/runtimes/21/install', () => ({ body: { runtime: managedRuntime, alreadyInstalled: false } }));
    const user = userEvent.setup();
    render(<App />);
    const section = await runtimesSection();
    expect(within(section).getByText('The required version is installed automatically on the first start.')).toBeInTheDocument();
    const buttons = within(section).getAllByRole('button', { name: /^Install Java \d+$/ });
    expect(buttons.map((button) => button.textContent)).toEqual(['Install Java 8', 'Install Java 17', 'Install Java 21', 'Install Java 25']);
    await user.click(within(section).getByRole('button', { name: 'Install Java 21' }));
    await waitFor(() => expect(api.callsTo('POST /api/java/runtimes/21/install')).toHaveLength(1));
    expect(await screen.findByText('Java 21 was installed.')).toBeInTheDocument();
  });

  it('keeps the success message while the runtime list is read again and then shows the new runtime', async () => {
    let installed = false;
    setup(systemFixture({ javaRuntimes: [] }));
    api.set('GET /api/system', () => ({ body: installed ? systemFixture({ javaRuntimes: [managedRuntime], managedJava: [managedInfo()] }) : systemFixture({ javaRuntimes: [] }) }));
    api.set('POST /api/java/runtimes/21/install', () => {
      installed = true;
      return { body: { runtime: managedRuntime, alreadyInstalled: false } };
    });
    const user = userEvent.setup();
    render(<App />);
    const section = await runtimesSection();
    await user.click(within(section).getByRole('button', { name: 'Install Java 21' }));
    expect(await screen.findByText('Java 21 was installed.')).toBeInTheDocument();
    await waitFor(() => expect(within(section).getAllByRole('listitem')).toHaveLength(1));
    expect(screen.getByText('Java 21 was installed.')).toBeInTheDocument();
    expect(within(section).getByText('Installed by WorldFoundry')).toBeInTheDocument();
  });

  it('shows the text of the error code when the installation fails', async () => {
    setup(systemFixture({ javaRuntimes: [] }));
    api.set('POST /api/java/runtimes/8/install', () => ({ status: 422, body: { error: { code: 'JAVA_NOT_AVAILABLE', message: 'Eclipse Temurin does not offer Java 8 for Windows (arm64).', details: { major: 8, platform: 'Windows (arm64)' } } } }));
    const user = userEvent.setup();
    render(<App />);
    const section = await runtimesSection();
    await user.click(within(section).getByRole('button', { name: 'Install Java 8' }));
    expect(await screen.findByText('Eclipse Temurin does not offer Java 8 for Windows (arm64). Please install Java 8 manually and enter its path in the server.')).toBeInTheDocument();
  });

  it('shows progress of a running installation from the event stream', async () => {
    setup(systemFixture({ javaRuntimes: [], javaInstalls: [{ major: 25, phase: 'download', percent: 10, message: 'Downloading Java 25 (6 of 59 MB)' }] }));
    render(<App />);
    const section = await runtimesSection();
    expect(await within(section).findByText('Downloading Java 25 (6 of 59 MB)')).toBeInTheDocument();
    FakeSocket.last.open();
    FakeSocket.last.receive({ type: 'java.install', major: 25, state: 'running', phase: 'extract', percent: 70, message: 'Unpacking Java 25 ...', error: null });
    expect(await within(section).findByText('Unpacking Java 25 ...')).toBeInTheDocument();
    expect(within(section).getByRole('progressbar', { name: 'Installation of Java 25' })).toHaveAttribute('aria-valuenow', '70');
    expect(within(section).getByRole('button', { name: 'Install Java 25' })).toBeDisabled();
  });

  it('explains a switched-off automatic installation and keeps the manual way visible', async () => {
    setup(systemFixture({ javaRuntimes: [], javaAutoInstall: false }));
    render(<App />);
    const section = await runtimesSection();
    expect(within(section).getByText(/Automatic installation is turned off \(JAVA_AUTO_INSTALL=false\)/)).toBeInTheDocument();
    expect(within(section).getByText('No Java installation found')).toBeInTheDocument();
    expect(within(section).getByRole('button', { name: 'Install Java 21' })).toBeEnabled();
  });
});

describe('autostart and deleting', () => {
  it('saves the autostart switch', async () => {
    setup(systemFixture());
    api.set('PATCH /api/servers/srv-1', (call) => ({ body: { server: serverFixture(call.body as Record<string, unknown>), restartRequired: false } }));
    const user = userEvent.setup();
    render(<App />);
    const toggle = await screen.findByRole('switch', { name: 'Start automatically when the application starts' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await user.click(toggle);
    const section = toggle.closest('section') as HTMLElement;
    await user.click(within(section).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.callsTo('PATCH /api/servers/srv-1')).toHaveLength(1));
    expect(api.callsTo('PATCH /api/servers/srv-1')[0]?.body).toEqual({ autoStart: true });
  });

  it('makes the user decide about the backups before a server with backups is deleted', async () => {
    setup(systemFixture());
    api.set('GET /api/servers/srv-1/backups', () => ({ body: { backups: [{ id: 'b1' }, { id: 'b2' }], schedule: { mode: 'off', intervalHours: null, times: [], everyDays: 1, timeZone: 'UTC', keepLast: 7, includeConfig: false, nextRunAt: null }, totalBytes: 3 * 1024 * 1024, freeBytes: null, running: false } }));
    api.set('DELETE /api/servers/srv-1', () => ({ body: { deleted: true } }));
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Delete server …' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete server permanently?' });
    const confirm = within(dialog).getByRole('button', { name: 'Delete server and all data' });
    await user.type(within(dialog).getByLabelText(/Type the name/), 'Survival');
    await user.click(within(dialog).getByRole('checkbox', { name: /all data of this server will be lost/ }));
    expect(await within(dialog).findByText(/What should happen to the 2 backups \(3 MB\)\?/)).toBeInTheDocument();
    expect(confirm).toBeDisabled();
    await user.click(within(dialog).getByRole('radio', { name: /Keep/ }));
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await waitFor(() => expect(api.callsTo('DELETE /api/servers/srv-1')).toHaveLength(1));
    expect(api.callsTo('DELETE /api/servers/srv-1')[0]?.url).toBe('/api/servers/srv-1?confirm=true&backups=keep');
  });

  it('asks nothing about backups when there are none', async () => {
    setup(systemFixture());
    api.set('DELETE /api/servers/srv-1', () => ({ body: { deleted: true } }));
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Delete server …' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete server permanently?' });
    await user.type(within(dialog).getByLabelText(/Type the name/), 'Survival');
    expect(within(dialog).queryByRole('radio')).not.toBeInTheDocument();
    const confirm = within(dialog).getByRole('button', { name: 'Delete server and all data' });
    // the typed name alone is not enough: the loss of all data must be confirmed as well
    expect(confirm).toBeDisabled();
    await user.click(within(dialog).getByRole('checkbox', { name: /all data of this server will be lost/ }));
    expect(within(dialog).getByText(/permanently removes its whole folder/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Delete server and all data' }));
    await waitFor(() => expect(api.callsTo('DELETE /api/servers/srv-1')).toHaveLength(1));
    expect(api.callsTo('DELETE /api/servers/srv-1')[0]?.url).toBe('/api/servers/srv-1?confirm=true');
  });
});
