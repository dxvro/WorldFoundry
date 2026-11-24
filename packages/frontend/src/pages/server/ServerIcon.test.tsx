import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../App';
import { FakeSocket } from '../../test/fakes';
import { baseRoutes, mockApi, serverFixture, systemFixture, type MockApi } from '../../test/mockApi';

// jsdom cannot decode or draw pictures; the scaling itself runs in the browser
const converted = new Blob(['png'], { type: 'image/png' });
vi.mock('../../lib/icon', async (original) => ({ ...(await original<typeof import('../../lib/icon')>()), toServerIcon: vi.fn(async () => converted) }));

let api: MockApi;

beforeEach(() => {
  FakeSocket.reset();
  vi.stubGlobal('WebSocket', FakeSocket);
  window.history.replaceState(null, '', '/servers/srv-1/config');
  api = mockApi({
    ...baseRoutes(serverFixture(), systemFixture()),
    'GET /api/servers/srv-1/properties': () => ({ body: { exists: false, properties: { 'server-port': 25565, gamemode: 'survival', difficulty: 'easy', 'white-list': false, 'max-players': 20, 'view-distance': 10, 'online-mode': true, motd: 'x' }, extra: {} } }),
    'PUT /api/servers/srv-1/icon': () => ({ body: { restartRequired: false } }),
    'DELETE /api/servers/srv-1/icon': () => ({ body: { restartRequired: false } }),
  });
});
afterEach(() => vi.unstubAllGlobals());

const iconSection = async (): Promise<HTMLElement> => (await screen.findByRole('heading', { name: 'Server icon' })).closest('section') as HTMLElement;

describe('server icon', () => {
  it('uploads the scaled picture as PNG and can remove it again', async () => {
    const user = userEvent.setup();
    render(<App />);
    const section = await iconSection();
    // the browser reports a missing icon as a broken image
    const image = within(section).getByRole('img', { name: /Icon of/ });
    image.dispatchEvent(new Event('error'));
    expect(await within(section).findByText('No icon')).toBeInTheDocument();

    const file = new File(['raw'], 'logo.jpg', { type: 'image/jpeg' });
    await user.upload(within(section).getByLabelText('Upload picture …'), file);
    expect(await within(section).findByText('The icon is saved.')).toBeInTheDocument();
    const [put] = api.callsTo('PUT /api/servers/srv-1/icon');
    expect(put?.body).toBe(converted);

    await user.click(within(section).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.callsTo('DELETE /api/servers/srv-1/icon')).toHaveLength(1));
    expect(await within(section).findByText('The icon is removed.')).toBeInTheDocument();
  });
});
