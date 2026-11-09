import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { FakeSocket } from '../test/fakes';
import { baseRoutes, mockApi, offline, serverFixture, type MockApi } from '../test/mockApi';

let api: MockApi;

const eventsSocket = (): FakeSocket => {
  const socket = FakeSocket.instances.find((entry) => entry.url.includes('/api/events'));
  if (socket === undefined) throw new Error('Kein Ereignis-Socket');
  return socket;
};

beforeEach(() => {
  FakeSocket.reset();
  vi.stubGlobal('WebSocket', FakeSocket);
  window.history.replaceState(null, '', '/servers/srv-1');
});
afterEach(() => vi.unstubAllGlobals());

function setup(server: Record<string, unknown>, extra: Record<string, () => { status?: number; body: unknown }> = {}): void {
  api = mockApi({
    ...baseRoutes(server),
    'GET /api/servers/srv-1/console/history': () => ({ body: { lines: [] } }),
    'GET /api/servers/srv-1/install-log': () => ({ body: { lines: [], totalLines: 0, truncated: false } }),
    ...extra,
  });
}

describe('starting without Java', () => {
  it('shows the preparing state with progress, a "Cancel" button and no kill/restart buttons', async () => {
    setup(serverFixture());
    api.set('POST /api/servers/srv-1/start', () => ({ body: { status: { ...offline, state: 'preparing', message: 'Installing Java 21 ...' }, warnings: [] } }));
    api.set('POST /api/servers/srv-1/stop', () => ({ body: { status: offline } }));
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Start' }));
    act(() => {
      eventsSocket().open();
      eventsSocket().receive({ type: 'server.status', serverId: 'srv-1', status: { ...offline, state: 'preparing', startedAt: Date.now(), message: 'Installing Java 21 (43 %) ...' } });
      eventsSocket().receive({ type: 'java.install', major: 21, state: 'running', phase: 'download', percent: 43, message: 'Downloading Java 21 (21 of 49 MB)', error: null });
    });
    expect(await screen.findByText('Installing Java 21 (43 %) ...')).toBeInTheDocument();
    expect(screen.getAllByText('Preparing').length).toBeGreaterThan(0);
    expect(screen.getByRole('progressbar', { name: 'Installation of Java 21' })).toHaveAttribute('aria-valuenow', '43');
    expect(screen.getByText('Downloading Java 21 (21 of 49 MB)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Force stop' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restart' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(api.callsTo('POST /api/servers/srv-1/stop')).toHaveLength(1));
  });

  it('shows a failed preparation as a start failure with the readable message', async () => {
    setup(serverFixture());
    render(<App />);
    await screen.findByRole('button', { name: 'Start' });
    act(() => {
      eventsSocket().open();
      eventsSocket().receive({ type: 'server.status', serverId: 'srv-1', status: { ...offline, state: 'crashed', message: 'The downloaded file does not match the expected checksum.' } });
    });
    expect(await screen.findByText('The server could not be started')).toBeInTheDocument();
    expect(screen.getByText(/expected checksum/)).toBeInTheDocument();
  });
});

describe('start errors about Java', () => {
  const missing = { status: 422, body: { error: { code: 'JAVA_NOT_FOUND', message: 'No Java installation was found. Java 21 or newer is needed.', details: { required: 21, requiredMax: null, found: [] } } } };

  it('offers to install the right Java instead of sending the user to the settings', async () => {
    setup(serverFixture());
    api.set('POST /api/servers/srv-1/start', () => missing);
    api.set('POST /api/java/runtimes/21/install', () => ({ body: { runtime: { major: 21 }, alreadyInstalled: false } }));
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Start' }));
    expect(await screen.findByText(/No Java installation was found/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Install Java 21' }));
    expect(await screen.findByText('Java 21 is installed. The server can be started now.')).toBeInTheDocument();
    expect(api.callsTo('POST /api/java/runtimes/21/install')).toHaveLength(1);
    expect(screen.queryByText('Java-Laufzeit einstellen')).not.toBeInTheDocument();
  });

  it('picks the major that satisfies the bounds of old Forge', async () => {
    setup(serverFixture({ loader: 'forge', mcVersion: '1.12.2', requiredJavaMajor: 8 }));
    api.set('POST /api/servers/srv-1/start', () => ({
      status: 422,
      body: { error: { code: 'JAVA_VERSION_INCOMPATIBLE', message: 'This server needs Java 8, found Java 21.', details: { required: 8, requiredMax: 8, found: [21] } } },
    }));
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Start' }));
    expect(await screen.findByRole('button', { name: 'Install Java 8' })).toBeInTheDocument();
  });

  it('does not offer an installation when the server pins its own Java path', async () => {
    setup(serverFixture({ javaPath: 'C:/kaputt/java.exe' }));
    api.set('POST /api/servers/srv-1/start', () => ({
      status: 422,
      body: { error: { code: 'JAVA_NOT_FOUND', message: 'Die eingestellte Java-Installation wurde was not found or does not start: C:/kaputt/java.exe', details: { javaPath: 'C:/kaputt/java.exe' } } },
    }));
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Start' }));
    expect(await screen.findByText(/was not found or does not start/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Install Java/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Change the Java path of the server' })).toHaveAttribute('href', '/servers/srv-1/config');
  });

  it('shows a failure of the manual installation under the button', async () => {
    setup(serverFixture());
    api.set('POST /api/servers/srv-1/start', () => missing);
    api.set('POST /api/java/runtimes/21/install', () => ({ status: 502, body: { error: { code: 'UPSTREAM_UNREACHABLE', message: 'The service "api.adoptium.net" cannot be reached. Please check the internet connection.' } } }));
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Start' }));
    await user.click(await screen.findByRole('button', { name: 'Install Java 21' }));
    expect(await screen.findByText('An external service cannot be reached. Please check the internet connection.')).toBeInTheDocument();
  });
});

describe('install panel and install log', () => {
  const installing = (): Record<string, unknown> => serverFixture({ installState: 'installing' });
  const fileLines = [
    { seq: 0, time: 1_700_000_000_000, text: '=== Installation of neoforge 1.21.1 started ===' },
    { seq: 1, time: 1_700_000_001_000, text: 'Querying the version at the source ...' },
    { seq: 2, time: 1_700_000_002_000, text: 'Querying Adoptium for Java 21 ...' },
  ];

  it('loads install.log when opened during an installation and continues with live lines without duplicates', async () => {
    setup(installing(), { 'GET /api/servers/srv-1/install-log': () => ({ body: { lines: fileLines, totalLines: 3, truncated: false } }) });
    render(<App />);
    const log = await screen.findByRole('log', { name: 'Installation log' });
    await waitFor(() => expect(log).toHaveTextContent('Querying Adoptium for Java 21 ...'));
    expect(api.callsTo('GET /api/servers/srv-1/install-log')[0]?.url).toBe('/api/servers/srv-1/install-log?tail=500');

    act(() => {
      eventsSocket().open();
      // line 2 is already in the file; 3 and 4 are new; 3 arrives twice (reconnect replay)
      eventsSocket().receive({ type: 'install.log', serverId: 'srv-1', line: 'Querying Adoptium for Java 21 ...', seq: 2, time: 1_700_000_002_000 });
      eventsSocket().receive({ type: 'install.log', serverId: 'srv-1', line: 'Downloading Java 21', seq: 3, time: 1_700_000_003_000 });
      eventsSocket().receive({ type: 'install.log', serverId: 'srv-1', line: 'Downloading Java 21', seq: 3, time: 1_700_000_003_000 });
      eventsSocket().receive({ type: 'install.log', serverId: 'srv-1', line: 'Unpacking Java 21', seq: 4, time: 1_700_000_004_000 });
    });
    await waitFor(() => expect(log).toHaveTextContent('Unpacking Java 21'));
    expect(log.textContent?.split('\n')).toEqual([
      '=== Installation of neoforge 1.21.1 started ===',
      'Querying the version at the source ...',
      'Querying Adoptium for Java 21 ...',
      'Downloading Java 21',
      'Unpacking Java 21',
    ]);
  });

  it('keeps live lines that arrived before the file was loaded and fills the gap by reading the file again', async () => {
    let calls = 0;
    setup(installing(), {
      'GET /api/servers/srv-1/install-log': () => {
        calls++;
        return calls === 1
          ? { body: { lines: fileLines.slice(0, 2), totalLines: 2, truncated: false } }
          : { body: { lines: [...fileLines, { seq: 3, time: 1, text: 'Line 3 from the file' }, { seq: 4, time: 1, text: 'Line 4 from the file' }], totalLines: 5, truncated: false } };
      },
    });
    render(<App />);
    const log = await screen.findByRole('log', { name: 'Installation log' });
    await waitFor(() => expect(log).toHaveTextContent('Querying the version at the source ...'));
    act(() => {
      eventsSocket().open();
      // lines 2 to 3 were missed: 4 arrives directly after the file's last line 1
      eventsSocket().receive({ type: 'install.log', serverId: 'srv-1', line: 'Line 4 live', seq: 4, time: 5 });
    });
    await waitFor(() => expect(api.callsTo('GET /api/servers/srv-1/install-log').length).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(log.textContent?.split('\n')).toHaveLength(5));
    expect(log.textContent?.split('\n').filter((line) => line.startsWith('Line 4'))).toHaveLength(1);
  });

  it('shows the log and the error text after a failed installation, with the file as source', async () => {
    setup(serverFixture({ installState: 'failed', installError: 'The installer failed with exit code 1.' }), {
      'GET /api/servers/srv-1/install-log': () => ({ body: { lines: [...fileLines, { seq: 3, time: 1, text: 'ERROR: The installer failed with exit code 1.' }], totalLines: 4, truncated: true } }),
    });
    render(<App />);
    expect(await screen.findByLabelText('Error message of the installation')).toHaveTextContent('exit code 1');
    const log = await screen.findByRole('log', { name: 'Installation log' });
    await waitFor(() => expect(log).toHaveTextContent('ERROR: The installer'));
    expect(screen.getByText(/From the file install.log in the server folder \(last 500 lines only\)/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start the installation again' })).toBeInTheDocument();
  });

  it('names the Java phase in the progress display', async () => {
    setup(installing());
    render(<App />);
    await screen.findByRole('log', { name: 'Installation log' });
    act(() => {
      eventsSocket().open();
      eventsSocket().receive({ type: 'install.progress', serverId: 'srv-1', phase: 'java', percent: 30, message: 'Downloading Java 21 (15 of 49 MB)' });
    });
    expect(await screen.findByText('Installing Java (30 %)')).toBeInTheDocument();
    expect(screen.getByText('Downloading Java 21 (15 of 49 MB)')).toBeInTheDocument();
  });

  it('reports a log that cannot be read without breaking the panel', async () => {
    setup(installing(), { 'GET /api/servers/srv-1/install-log': () => ({ status: 409, body: { error: { code: 'INSTALL_LOG_UNSAFE', message: 'The log file is not a regular file and will not be read.' } } }) });
    render(<App />);
    expect(await screen.findByText('The log file is not a regular file and will not be read.')).toBeInTheDocument();
    expect(within(await screen.findByRole('log', { name: 'Installation log' })).queryByText(/Loading log/)).not.toBeInTheDocument();
  });
});
