import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { FakeSocket } from './test/fakes';

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const unauthorized = { error: { code: 'UNAUTHORIZED', message: 'Sign-in required. Please sign in with the access token.' } };

interface World {
  authenticated: boolean;
  authRequired: boolean;
}

function installFetch(world: World): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.startsWith('/api/auth/status')) return json(200, { authRequired: world.authRequired, authenticated: world.authenticated });
    if (url.startsWith('/api/auth/login')) {
      const { token } = JSON.parse(String(init?.body)) as { token: string };
      if (token !== 'correct123') return json(401, { error: { code: 'INVALID_TOKEN', message: 'The access token is invalid.' } });
      world.authenticated = true;
      return json(200, { authRequired: true, authenticated: true });
    }
    if (url.startsWith('/api/auth/logout') && method === 'POST') {
      world.authenticated = false;
      return json(200, { authenticated: false });
    }
    if (!world.authenticated && world.authRequired) return json(401, unauthorized);
    if (url.startsWith('/api/servers')) return json(200, { servers: [] });
    if (url.startsWith('/api/health')) return json(200, { status: 'ok', database: 'ok', lanUrls: [] });
    if (url.startsWith('/api/system')) return json(200, { totalMemoryMb: 16384, freeMemoryMb: 8000, cpuCount: 8, platform: 'win32', arch: 'x64', javaRuntimes: [] });
    return json(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

describe('App authentication', () => {
  beforeEach(() => {
    FakeSocket.reset();
    vi.stubGlobal('WebSocket', FakeSocket);
    window.history.replaceState(null, '', '/');
  });
  afterEach(() => vi.unstubAllGlobals());

  it('goes straight to the overview when no login is required, without a logout button', async () => {
    installFetch({ authRequired: false, authenticated: true });
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument();
    expect(await screen.findByText('No server created yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Log out/ })).not.toBeInTheDocument();
  });

  it('shows the login screen when the status says a login is required', async () => {
    installFetch({ authRequired: true, authenticated: false });
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Sign-in required' })).toBeInTheDocument();
  });

  it('shows the error for a wrong token and enters the app with the right one', async () => {
    installFetch({ authRequired: true, authenticated: false });
    const user = userEvent.setup();
    render(<App />);
    const field = await screen.findByLabelText('Access token');
    await user.type(field, 'wrong');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('The password or access token is invalid.')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Access token'), 'correct123');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Log out/ }).length).toBeGreaterThan(0);
  });

  it('returns to the login screen when any request answers 401', async () => {
    const world: World = { authRequired: true, authenticated: true };
    installFetch(world);
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument();

    // the session expires on the server; the next API call is refused
    world.authenticated = false;
    const user = userEvent.setup();
    await user.click(screen.getAllByRole('link', { name: 'System' })[0] as HTMLElement);
    // the system page loads its data, which answers 401
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Sign-in required' })).toBeInTheDocument());
  });

  it('logs out through the button', async () => {
    installFetch({ authRequired: true, authenticated: true });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { name: 'Overview' });
    await user.click(screen.getAllByRole('button', { name: /Log out/ })[0] as HTMLElement);
    expect(await screen.findByRole('heading', { name: 'Sign-in required' })).toBeInTheDocument();
  });

  it('opens the event stream on the page host and shows a banner while it is down', async () => {
    installFetch({ authRequired: false, authenticated: true });
    render(<App />);
    await screen.findByRole('heading', { name: 'Overview' });
    expect(FakeSocket.instances.some((socket) => socket.url.endsWith('/api/events'))).toBe(true);
    expect(await screen.findByText(/Connecting to the server/)).toBeInTheDocument();
  });
});
