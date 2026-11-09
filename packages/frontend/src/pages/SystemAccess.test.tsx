import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { en } from '../i18n';

const DISCLAIMER = en.common.disclaimer;
import { passwordStrength } from '../lib/password';
import { FakeSocket } from '../test/fakes';
import { baseRoutes, mockApi, networkFixture, serverFixture, type MockApi } from '../test/mockApi';

let api: MockApi;

function setup(options: { auth?: { authRequired: boolean; credential: string; authenticated?: boolean }; network?: Record<string, unknown> } = {}): void {
  const auth = options.auth ?? { authRequired: true, credential: 'token' };
  api = mockApi({
    ...baseRoutes(serverFixture()),
    'GET /api/auth/status': () => ({ body: { authRequired: auth.authRequired, authenticated: auth.authenticated ?? true, credential: auth.credential } }),
    'GET /api/system/network': () => ({ body: networkFixture(options.network) }),
    'POST /api/auth/password': () => ({ body: { authRequired: true, authenticated: true, credential: 'password' } }),
  });
}

beforeEach(() => {
  FakeSocket.reset();
  vi.stubGlobal('WebSocket', FakeSocket);
  window.history.replaceState(null, '', '/system');
});
afterEach(() => vi.unstubAllGlobals());

describe('disclaimer', () => {
  it('is on the login page', async () => {
    setup({ auth: { authRequired: true, credential: 'token', authenticated: false } });
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Sign-in required' })).toBeInTheDocument();
    expect(screen.getByText(DISCLAIMER)).toBeInTheDocument();
  });

  it('is on the pages of the app (sidebar on desktop, footer on phones)', async () => {
    setup();
    window.history.replaceState(null, '', '/');
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument();
    expect(screen.getAllByText(DISCLAIMER).length).toBeGreaterThanOrEqual(1);
    expect(DISCLAIMER).toBe('Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft.');
  });

  it('asks for the password once one was set', async () => {
    setup({ auth: { authRequired: true, credential: 'password', authenticated: false } });
    render(<App />);
    expect(await screen.findByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByText(/worldfoundry reset-password/)).toBeInTheDocument();
  });
});

describe('password strength hint', () => {
  it('grades length and variety', () => {
    expect(passwordStrength('kurz')).toMatchObject({ level: 0, label: 'Too short' });
    expect(passwordStrength('aaaaaaaaaaaa').level).toBe(1);
    expect(passwordStrength('abcdefghijkl').level).toBe(1);
    expect(passwordStrength('Abcdefg123').level).toBe(2);
    expect(passwordStrength('Correct-Horse-Battery9')).toMatchObject({ level: 3, label: 'Strong' });
  });
});

describe('password section', () => {
  it('changes the password with the current one and keeps the session', async () => {
    setup();
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Password' })).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'Change password' });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText('Current password'), 'altes-token-1');
    await user.type(screen.getByLabelText('New password'), 'kurz');
    expect(screen.getByText('At least 10 characters.')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('New password'));
    await user.type(screen.getByLabelText('New password'), 'Correct-Horse-Battery9');
    expect(screen.getByText(/Strong\./)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Repeat new password'), 'Correct-Horse-Battery');
    expect(screen.getByText('The two entries do not match.')).toBeInTheDocument();
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText('Repeat new password'), '9');
    expect(submit).toBeEnabled();
    await user.click(submit);
    await waitFor(() => expect(api.callsTo('POST /api/auth/password')).toHaveLength(1));
    expect(api.callsTo('POST /api/auth/password')[0]?.body).toEqual({ currentPassword: 'altes-token-1', newPassword: 'Correct-Horse-Battery9' });
    expect(await screen.findByText('The password has been changed')).toBeInTheDocument();
    expect(screen.getByLabelText('New password')).toHaveValue('');
  });

  it('shows the German reason for a wrong current password', async () => {
    setup();
    api.set('POST /api/auth/password', () => ({ status: 403, body: { error: { code: 'CURRENT_PASSWORD_WRONG', message: 'The current password is wrong.' } } }));
    const user = userEvent.setup();
    render(<App />);
    await user.type(await screen.findByLabelText('Current password'), 'wrong-wrong');
    await user.type(screen.getByLabelText('New password'), 'Correct-Horse-Battery9');
    await user.type(screen.getByLabelText('Repeat new password'), 'Correct-Horse-Battery9');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText('The current password is wrong.')).toBeInTheDocument();
    expect(screen.queryByText('The password has been changed')).not.toBeInTheDocument();
  });

  it('warns about open access and sets a first password without a current one', async () => {
    setup({ auth: { authRequired: false, credential: 'none' } });
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByText('No password is set')).toBeInTheDocument();
    expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('New password'), 'Correct-Horse-Battery9');
    await user.type(screen.getByLabelText('Repeat new password'), 'Correct-Horse-Battery9');
    await user.click(screen.getByRole('button', { name: 'Set password' }));
    await waitFor(() => expect(api.callsTo('POST /api/auth/password')[0]?.body).toEqual({ newPassword: 'Correct-Horse-Battery9' }));
  });
});

describe('network section', () => {
  it('lists the addresses, tucks virtual adapters away and explains the router tip', async () => {
    setup();
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Network & access' })).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'http://192.168.178.20:3000' })).toHaveAttribute('href', 'http://192.168.178.20:3000');
    expect(screen.getByRole('link', { name: 'http://MCPC:3000' })).toBeInTheDocument();
    const virtual = screen.getByText(/VPN \/ virtual adapters \(1\)/);
    expect(virtual.closest('details')).not.toBeNull();
    expect(within(virtual.closest('details') as HTMLElement).getByText('http://172.28.16.1:3000')).toBeInTheDocument();
    expect(screen.getByText(/Always assign the same IPv4 address/)).toBeInTheDocument();
  });

  it('offers the local addresses and saves; values equal to the config file defaults are sent as "not set"', async () => {
    setup();
    api.set('PUT /api/system/network', (call) => {
      const body = call.body as Record<string, unknown>;
      return {
        body: networkFixture({
          settings: { bindHost: body['bindHost'], port: body['port'], allowedHosts: body['allowedHosts'], publicAddress: body['publicAddress'] },
          restartRequired: true,
          pending: { host: '192.168.178.20', port: 3100, allowedHosts: ['minecraft.fritz.box'], urls: ['http://192.168.178.20:3100'] },
        }),
      };
    });
    const user = userEvent.setup();
    render(<App />);
    const select = await screen.findByLabelText('Listen on');
    expect(within(select).getByRole('option', { name: '192.168.178.20 (Ethernet)' })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: 'This computer only (127.0.0.1)' })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: /172\.28\.16\.1.*VPN\/virtual/ })).toBeInTheDocument();
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    await user.selectOptions(select, '192.168.178.20');
    await user.clear(screen.getByLabelText('Web port'));
    await user.type(screen.getByLabelText('Web port'), '3100');
    await user.type(screen.getByLabelText('Other allowed host names'), 'minecraft.fritz.box');
    await user.click(save);
    await waitFor(() => expect(api.callsTo('PUT /api/system/network')).toHaveLength(1));
    expect(api.callsTo('PUT /api/system/network')[0]?.body).toEqual({ bindHost: '192.168.178.20', port: 3100, allowedHosts: ['minecraft.fritz.box'], publicAddress: null });
    expect(await screen.findByText(/Saved\. A restart applies/)).toBeInTheDocument();
    expect(screen.getByText(/must allow the new port 3100/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restart now' })).toBeInTheDocument();
  });

  it('shows server-side validation errors', async () => {
    setup();
    api.set('PUT /api/system/network', () => ({ status: 422, body: { error: { code: 'NETWORK_PORT_IN_USE', message: 'The port 3555 is already in use on this computer. Please choose a free port.' } } }));
    const user = userEvent.setup();
    render(<App />);
    await user.clear(await screen.findByLabelText('Web port'));
    await user.type(screen.getByLabelText('Web port'), '3555');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/already in use/)).toBeInTheDocument();
  });

  it('shows the fallback warning from the start', async () => {
    setup({ network: { warnings: ['The address 10.9.9.9 does not exist on this computer.'] } });
    render(<App />);
    expect(await screen.findByText(/10\.9\.9\.9 does not exist on this computer/)).toBeInTheDocument();
  });

  it('restarts only after the confirmation, which names the stopped servers and the new address', async () => {
    setup({ network: { restartRequired: true, pending: { host: '0.0.0.0', port: 3100, allowedHosts: [], urls: ['http://192.168.178.20:3100'] } } });
    api.set('POST /api/system/restart', () => ({ status: 202, body: { restarting: true, urls: ['http://192.168.178.20:3100'], automatic: true, note: 'Der Dienst startet neu.' } }));
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Restart now' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/All running Minecraft servers will be stopped/)).toBeInTheDocument();
    expect(within(dialog).getByText('http://192.168.178.20:3100')).toBeInTheDocument();
    expect(api.callsTo('POST /api/system/restart')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Restart now' }));
    await waitFor(() => expect(api.callsTo('POST /api/system/restart')).toHaveLength(1));
    expect(api.callsTo('POST /api/system/restart')[0]?.body).toEqual({ confirm: true });
    expect(await screen.findByText('WorldFoundry is restarting …')).toBeInTheDocument();
  });

  it('tells a manual installation to start the program again by hand', async () => {
    const note = 'This installation runs without a service: WorldFoundry exits and must be started again by hand afterwards.';
    setup({ network: { restartRequired: true, restart: { automatic: false, note } } });
    api.set('POST /api/system/restart', () => ({ status: 202, body: { restarting: true, urls: ['http://192.168.178.20:3000'], automatic: false, note } }));
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Restart now' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Restart now' }));
    expect(await screen.findByText('Please restart WorldFoundry by hand now')).toBeInTheDocument();
  });
});
