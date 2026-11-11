import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../App';
import { FakeSocket } from '../../test/fakes';
import { FakeXhr } from '../../test/fakeXhr';
import { baseRoutes, mockApi, offline, serverFixture, type MockApi } from '../../test/mockApi';

const zomboid = serverFixture({ game: 'zomboid', loader: 'vanilla', mcVersion: '', loaderVersion: null, port: 16261, gameSettings: JSON.stringify({ profile: 'knox', branch: 'public', udpPort: 16262, adminPassword: 'pw-123456' }), status: offline });
const listed = { supported: true, accept: '.zip,.tar.gz,.tgz', mods: [{ id: 'MyMod', name: 'My Mod', location: 'data/mods/MyMod', sizeBytes: 2048, active: true }] };

let api: MockApi;
beforeEach(() => {
  FakeSocket.reset();
  vi.stubGlobal('WebSocket', FakeSocket);
});
afterEach(() => vi.unstubAllGlobals());

describe('own mods', () => {
  it('lists uploaded mods of a Zomboid server, uploads a zip with a warning about unknown files, and removes a mod', async () => {
    FakeXhr.install({ status: 200, body: { ...listed, installed: [{ id: 'Other', name: 'Other Mod' }] } });
    api = mockApi({
      ...baseRoutes(zomboid),
      'GET /api/servers/srv-1/workshop': () => ({ body: { items: [], mods: [], maps: ['Muldraugh, KY'], detailsError: null } }),
      'GET /api/servers/srv-1/custom-mods': () => ({ body: listed }),
      'DELETE /api/servers/srv-1/custom-mods/MyMod': () => ({ body: { ...listed, mods: [] } }),
    });
    window.history.replaceState(null, '', '/servers/srv-1/workshop');
    render(<App />);
    const user = userEvent.setup();
    const section = (await screen.findByRole('heading', { name: 'Own mods' })).closest('section') as HTMLElement;
    expect(within(section).getByText(/mod\.info, or 42\/mod\.info/)).toBeInTheDocument();
    expect(within(section).getByText(/Only upload files you trust/)).toBeInTheDocument();
    expect(await within(section).findByText('My Mod')).toBeInTheDocument();
    expect(within(section).getByText(/data\/mods\/MyMod · 2 KB · active/)).toBeInTheDocument();

    await user.upload(within(section).getByLabelText('Upload mod …', { selector: 'input' }), new File(['zip'], 'other.zip'));
    expect(await within(section).findByText('Added: Other Mod')).toBeInTheDocument();
    expect(FakeXhr.sent).toEqual([expect.objectContaining({ url: '/api/servers/srv-1/custom-mods?fileName=other.zip' })]);

    await user.click(within(section).getByRole('button', { name: 'Remove My Mod' }));
    await waitFor(() => expect(api.callsTo('DELETE /api/servers/srv-1/custom-mods/MyMod')).toHaveLength(1));
  });
});
