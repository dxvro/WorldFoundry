import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { parseBlocks, safeHref, SafeMarkdown } from '../lib/markdown';
import { bannerKind } from '../lib/update';
import { FakeSocket } from '../test/fakes';
import { baseRoutes, mockApi, serverFixture, type MockApi } from '../test/mockApi';
import { initialLiveState, liveReducer } from '../live/reducer';
import type { SystemUpdateState } from '../lib/types';

const updateState = (overrides: Partial<SystemUpdateState> = {}): SystemUpdateState => ({
  currentVersion: '0.1.0',
  installMode: 'service',
  installModeNote: null,
  installModeNoteRef: null,
  lastCheckErrorRef: null,
  canApplyReasonRef: null,
  errorRef: null,
  checksEnabled: true,
  autoCheck: true,
  channel: 'stable',
  repo: 'dxvro/WorldFoundry',
  countdownSeconds: 60,
  checking: false,
  lastCheckAt: Date.parse('2026-11-05T10:00:00Z'),
  lastCheckError: null,
  latest: { version: '0.2.0', name: 'WorldFoundry 0.2.0', notes: '## New\n- **Update function**\n- Fixed bugs `x`', publishedAt: '2026-11-05T09:00:00Z', htmlUrl: 'https://github.com/dxvro/WorldFoundry/releases/tag/v0.2.0', prerelease: false, assetSizeBytes: 90 * 1024 * 1024 },
  updateAvailable: true,
  canApply: true,
  canApplyReason: null,
  phase: 'idle',
  progress: null,
  error: null,
  job: null,
  history: [],
  ...overrides,
});

let api: MockApi;
let current: SystemUpdateState;

function setup(state: SystemUpdateState): void {
  current = state;
  api = mockApi({
    ...baseRoutes(serverFixture({ status: { state: 'online', pid: 1, startedAt: null, exitCode: null, message: null, players: [], port: 25565, cpuPercent: null, rssBytes: null } })),
    'GET /api/system/update': () => ({ body: current }),
    'POST /api/system/update/check': () => ({ body: (current = { ...current, lastCheckAt: Date.now() }) }),
    'POST /api/system/update/apply': (call) => ({ status: 202, body: (current = { ...current, phase: 'downloading', progress: { messageRef: null, message: `Start ${JSON.stringify(call.body)}`, percent: 0, countdownRemaining: null } }) }),
    'PATCH /api/system/update/settings': (call) => ({ body: (current = { ...current, autoCheck: (call.body as { autoCheck: boolean }).autoCheck }) }),
    'POST /api/system/update/dismiss': () => ({ body: (current = { ...current, phase: 'idle', error: null }) }),
  });
}

beforeEach(() => {
  FakeSocket.reset();
  vi.stubGlobal('WebSocket', FakeSocket);
  window.history.replaceState(null, '', '/');
});
afterEach(() => vi.unstubAllGlobals());

describe('safe release notes', () => {
  it('renders headings, lists, bold and code as elements and never as HTML', () => {
    render(<SafeMarkdown source={'## New\n- **bold** and `code`\n- second item\n\nParagraph <img src=x onerror=alert(1)> <script>alert(2)</script>'} />);
    expect(screen.getByText('New')).toBeInTheDocument();
    expect(screen.getByText('bold').tagName).toBe('STRONG');
    expect(screen.getByText('code').tagName).toBe('CODE');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(screen.getByText(/<script>alert\(2\)<\/script>/)).toBeInTheDocument();
  });

  it('links only to http(s) addresses', () => {
    render(<SafeMarkdown source={'[good](https://github.com/x) [evil](javascript:alert(1)) [also](data:text/html;base64,AAAA)'} />);
    const link = screen.getByRole('link', { name: 'good' });
    expect(link).toHaveAttribute('href', 'https://github.com/x');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(screen.queryByRole('link', { name: 'evil' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'also' })).not.toBeInTheDocument();
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('https://a.b/c')).toBe('https://a.b/c');
    expect(parseBlocks('')).toEqual([]);
  });
});

describe('reducer and banner choice', () => {
  it('keeps the latest update state from events', () => {
    const state = liveReducer(initialLiveState(), { type: 'message', message: { type: 'update.state', state: updateState() } as never });
    expect(state.update?.latest?.version).toBe('0.2.0');
  });

  it('chooses what the banner says', () => {
    expect(bannerKind(null)).toBeNull();
    expect(bannerKind(updateState())).toBe('available');
    expect(bannerKind(updateState({ updateAvailable: false }))).toBeNull();
    expect(bannerKind(updateState({ phase: 'waiting-for-servers' }))).toBe('running');
    expect(bannerKind(updateState({ phase: 'done' }))).toBe('done');
    expect(bannerKind(updateState({ phase: 'failed', error: 'x' }))).toBe('failed');
  });
});

describe('update banner', () => {
  it('shows the new version and its notes on every page', async () => {
    setup(updateState());
    render(<App />);
    expect(await screen.findByText(/Version 0\.2\.0/)).toBeInTheDocument();
    expect(screen.getByText(/Installed: 0\.1\.0/)).toBeInTheDocument();
    expect(screen.getByText('Release notes')).toBeInTheDocument();
    expect(screen.getByText('Update function')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Update now' })).toBeEnabled();
  });

  it('asks for confirmation naming the running servers and sends the countdown', async () => {
    setup(updateState());
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Update now' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/All running Minecraft servers will be stopped/)).toBeInTheDocument();
    expect(api.callsTo('POST /api/system/update/apply')).toHaveLength(0);
    const countdown = within(dialog).getByLabelText(/Countdown/);
    await user.clear(countdown);
    await user.type(countdown, '45');
    await user.click(within(dialog).getByRole('button', { name: 'Update now' }));
    await waitFor(() => expect(api.callsTo('POST /api/system/update/apply')).toHaveLength(1));
    expect(api.callsTo('POST /api/system/update/apply')[0]?.body).toEqual({ confirm: true, countdownSeconds: 45 });
    expect(await screen.findByText('Downloading the update')).toBeInTheDocument();
  });

  it('does not accept an invalid countdown', async () => {
    setup(updateState());
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Update now' }));
    const dialog = await screen.findByRole('dialog');
    const countdown = within(dialog).getByLabelText(/Countdown/);
    await user.clear(countdown);
    await user.type(countdown, '9999');
    expect(within(dialog).getAllByRole('button', { name: 'Update now' })[0]).toBeDisabled();
  });

  it('only links to the release when the installation cannot update itself', async () => {
    setup(updateState({ installMode: 'portable', canApply: false, canApplyReason: 'This installation runs without an update service.', installModeNote: 'This installation runs without an update service.' }));
    render(<App />);
    expect(await screen.findByText(/Version 0\.2\.0/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update now' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Go to the download page/ })).toHaveAttribute('href', 'https://github.com/dxvro/WorldFoundry/releases/tag/v0.2.0');
    expect(screen.getByText('This installation runs without an update service.')).toBeInTheDocument();
  });

  it('shows nothing when there is nothing new, and follows live progress events', async () => {
    setup(updateState({ updateAvailable: false }));
    render(<App />);
    await screen.findByRole('heading', { name: 'Overview' });
    await waitFor(() => expect(api.callsTo('GET /api/system/update')).toHaveLength(1));
    expect(screen.queryByText(/is available/)).not.toBeInTheDocument();
    act(() => FakeSocket.last.open());
    act(() =>
      FakeSocket.last.receive({ type: 'update.state', state: updateState({ phase: 'waiting-for-servers', progress: { messageRef: null, message: 'Servers will be stopped in 42 s (players were warned).', percent: null, countdownRemaining: 42 } }) }),
    );
    expect(await screen.findByText('Warning and stopping the servers')).toBeInTheDocument();
    expect(screen.getByText(/stopped in 42 s/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel update' })).toBeInTheDocument();
    act(() => FakeSocket.last.receive({ type: 'update.state', state: updateState({ phase: 'failed', error: 'The release signature is invalid.' }) }));
    expect(await screen.findByText(/The release signature is invalid/)).toBeInTheDocument();
  });
});

describe('system page', () => {
  it('shows version, last check, the switch for automatic checks and the history', async () => {
    setup(
      updateState({
        history: [
          { id: 2, fromVersion: '0.1.0', toVersion: '0.2.0', result: 'rolled_back', messageRef: null, message: 'The previous version is running again.', stoppedServers: 1, startedAt: 1, finishedAt: Date.parse('2026-11-05T11:00:00Z') },
          { id: 1, fromVersion: '0.0.9', toVersion: '0.1.0', result: 'success', messageRef: null, message: 'Auf Version 0.1.0 aktualisiert.', stoppedServers: 0, startedAt: 1, finishedAt: Date.parse('2026-11-01T11:00:00Z') },
        ],
      }),
    );
    window.history.replaceState(null, '', '/system');
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'System' })).toBeInTheDocument();
    expect(await screen.findByText('0.1.0', { selector: 'dd' })).toBeInTheDocument();
    expect(screen.getByText('Rolled back')).toBeInTheDocument();
    expect(screen.getByText('Successful')).toBeInTheDocument();
    expect(screen.getByText('The previous version is running again.')).toBeInTheDocument();

    const toggle = screen.getByRole('switch', { name: 'Check for updates automatically' });
    expect(toggle).toBeChecked();
    await user.click(toggle);
    await waitFor(() => expect(api.callsTo('PATCH /api/system/update/settings')[0]?.body).toEqual({ autoCheck: false }));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Check for updates automatically' })).not.toBeChecked());

    await user.click(screen.getByRole('button', { name: 'Check now' }));
    await waitFor(() => expect(api.callsTo('POST /api/system/update/check')).toHaveLength(1));
  });

  it('explains why a checkout cannot update itself and that checks can be switched off', async () => {
    setup(updateState({ installMode: 'dev', installModeNote: 'WorldFoundry runs from source.', canApply: false, canApplyReason: 'WorldFoundry runs from source.', checksEnabled: false }));
    window.history.replaceState(null, '', '/system');
    render(<App />);
    expect(await screen.findByText('Source code (development)')).toBeInTheDocument();
    expect(screen.getAllByText('WorldFoundry runs from source.').length).toBeGreaterThan(0);
    expect(screen.getByText(/UPDATE_CHECK=false/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check now' })).toBeDisabled();
  });

  it('shows the failure of an update and lets it be dismissed', async () => {
    setup(updateState({ phase: 'failed', error: 'The new version does not respond. The previous version is running again.' }));
    window.history.replaceState(null, '', '/system');
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByText('The update failed')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Got it' }));
    await waitFor(() => expect(api.callsTo('POST /api/system/update/dismiss')).toHaveLength(1));
  });
});
