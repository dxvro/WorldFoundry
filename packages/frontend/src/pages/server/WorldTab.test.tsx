import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../App';
import { FakeSocket } from '../../test/fakes';
import { baseRoutes, mockApi, offline, serverFixture, type MockApi } from '../../test/mockApi';
import { buildRows, draftPatch, fieldErrorsFrom, isValidLevelName, normalizeValue } from './WorldTab';
import { ApiError } from '../../lib/api';

interface Entry {
  key: string;
  value: string;
  known: boolean;
}

const catalog = [
  { key: 'level-name', type: 'string', category: 'world', default: 'world' },
  { key: 'level-seed', type: 'string', category: 'world', default: '' },
  { key: 'level-type', type: 'string', category: 'world', default: 'minecraft:normal', suggestions: ['minecraft:normal', 'minecraft:flat'] },
  { key: 'view-distance', type: 'integer', category: 'world', default: '10', min: 2, max: 32 },
  { key: 'gamemode', type: 'enum', category: 'gameplay', default: 'survival', options: ['survival', 'creative', 'adventure', 'spectator'] },
  { key: 'difficulty', type: 'enum', category: 'gameplay', default: 'easy', options: ['peaceful', 'easy', 'normal', 'hard'] },
  { key: 'hardcore', type: 'boolean', category: 'gameplay', default: 'false' },
  { key: 'pvp', type: 'boolean', category: 'gameplay', default: 'true' },
  { key: 'max-players', type: 'integer', category: 'players', default: '20', min: 1, max: 10000 },
  { key: 'white-list', type: 'boolean', category: 'players', default: 'false' },
  { key: 'motd', type: 'string', category: 'network', default: 'A Minecraft Server' },
  { key: 'server-port', type: 'integer', category: 'network', default: '25565', min: 1, max: 65535 },
  { key: 'rcon.password', type: 'string', category: 'network', default: '', secret: true },
  { key: 'max-tick-time', type: 'integer', category: 'advanced', default: '60000', min: -1, max: 2147483647 },
];

const fileEntries = (): Entry[] => [
  { key: 'level-name', value: 'world', known: true },
  { key: 'level-seed', value: '12345', known: true },
  { key: 'view-distance', value: '12', known: true },
  { key: 'gamemode', value: 'survival', known: true },
  { key: 'pvp', value: 'true', known: true },
  { key: 'motd', value: 'Hello world', known: true },
  { key: 'server-port', value: '25565', known: true },
  { key: 'rcon.password', value: 'geheim', known: true },
  { key: 'my-mod.option', value: '7', known: false },
];

const onlineStatus = { ...offline, state: 'online' };
const offlineStatus: Record<string, unknown> = offline;

let api: MockApi;
let entries: Entry[];
let exists: boolean;
let nextPut: (() => { status: number; body: unknown } | null) | null;
let serverStatus: Record<string, unknown> = offlineStatus;

const viewBody = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  exists,
  properties: { 'server-port': 25565, gamemode: 'survival', difficulty: 'easy', 'white-list': false, 'max-players': 20, 'view-distance': 12, 'online-mode': true, motd: 'Hello world' },
  extra: Object.fromEntries(entries.filter((entry) => !entry.known).map((entry) => [entry.key, entry.value])),
  entries,
  ...extra,
});

// the whole app on the world tab; the server's status comes from the (fake) server list, the language from the stored choice
function ui(status: Record<string, unknown> = offlineStatus): ReactNode {
  serverStatus = status;
  window.history.replaceState(null, '', '/servers/srv-1/world');
  return <App />;
}

function setup(options: { exists?: boolean; levelNameChanged?: boolean; restartRequired?: boolean; liveOverwriteRisk?: boolean } = {}): void {
  entries = fileEntries();
  exists = options.exists ?? true;
  nextPut = null;
  api = mockApi({
    ...baseRoutes(serverFixture()),
    'GET /api/servers': () => ({ body: { servers: [serverFixture({ status: serverStatus })] } }),
    'GET /api/servers/srv-1/properties': () => ({ body: viewBody() }),
    'GET /api/properties/catalog': () => ({ body: { catalog } }),
    'PUT /api/servers/srv-1/properties/entries': ({ body }) => {
      const failure = nextPut?.();
      if (failure) return failure;
      const patch = body as { set?: Record<string, string>; remove?: string[] };
      const next = entries.filter((entry) => !(patch.remove ?? []).includes(entry.key));
      for (const [key, value] of Object.entries(patch.set ?? {})) {
        const found = next.find((entry) => entry.key === key);
        if (found) found.value = value;
        else next.push({ key, value, known: catalog.some((def) => def.key === key) });
      }
      entries = next;
      exists = true;
      return { body: viewBody({ restartRequired: options.restartRequired ?? false, levelNameChanged: options.levelNameChanged ?? false, liveOverwriteRisk: options.liveOverwriteRisk ?? false }) };
    },
  });
}

const region = (name: string): HTMLElement => screen.getByRole('region', { name });
const rowOf = (key: string): HTMLElement => {
  const found = document.querySelector<HTMLElement>(`[data-testid="property-row"][data-key="${key}"]`);
  if (found === null) throw new Error(`no row for ${key}`);
  return found;
};
const rowKeys = (): string[] => screen.queryAllByTestId('property-row').map((row) => row.getAttribute('data-key') ?? '');
const saveButton = (): HTMLElement => screen.getByRole('button', { name: 'Save changes' });
const putCalls = (): ReturnType<MockApi['callsTo']> => api.callsTo('PUT /api/servers/srv-1/properties/entries');

beforeEach(() => {
  FakeSocket.reset();
  vi.stubGlobal('WebSocket', FakeSocket);
});
afterEach(() => vi.unstubAllGlobals());

describe('helpers', () => {
  const rows = buildRows(fileEntries(), catalog as never, []);

  it('builds catalog rows in catalog order, then unknown keys, then new ones', () => {
    const built = buildRows(fileEntries(), catalog as never, ['extra.key']);
    expect(built.map((row) => row.key)).toEqual([...catalog.map((def) => def.key), 'my-mod.option', 'extra.key']);
    const hardcore = built.find((row) => row.key === 'hardcore');
    expect(hardcore).toMatchObject({ inFile: false, baseline: 'false', isNew: false });
    expect(built.find((row) => row.key === 'view-distance')).toMatchObject({ inFile: true, baseline: '12' });
    expect(built.find((row) => row.key === 'extra.key')).toMatchObject({ isNew: true, def: undefined });
  });

  it('sends only what differs from the file', () => {
    expect(draftPatch(rows, { edits: {}, removed: [], added: [] })).toEqual({});
    expect(draftPatch(rows, { edits: { pvp: 'true', motd: 'Neu' }, removed: [], added: [] })).toEqual({ set: { motd: 'Neu' } });
    expect(draftPatch(rows, { edits: { motd: 'Neu' }, removed: ['my-mod.option'], added: [] })).toEqual({ set: { motd: 'Neu' }, remove: ['my-mod.option'] });
    // a removed key is never also set
    expect(draftPatch(rows, { edits: { 'my-mod.option': '9' }, removed: ['my-mod.option'], added: [] })).toEqual({ remove: ['my-mod.option'] });
  });

  it('reads the numeric game mode and difficulty of old servers as names, without a false change', () => {
    const legacy = buildRows([{ key: 'gamemode', value: '1' }, { key: 'difficulty', value: '3' }] as never, catalog as never, []);
    expect(legacy.find((row) => row.key === 'gamemode')).toMatchObject({ baseline: 'creative', inFile: true });
    expect(legacy.find((row) => row.key === 'difficulty')).toMatchObject({ baseline: 'hard', inFile: true });
    expect(draftPatch(legacy, { edits: {}, removed: [], added: [] })).toEqual({});
    // a change is sent by name; the backend maps it back to the number
    expect(draftPatch(legacy, { edits: { difficulty: 'peaceful' }, removed: [], added: [] })).toEqual({ set: { difficulty: 'peaceful' } });
    expect(normalizeValue('gamemode', '0')).toBe('survival');
    expect(normalizeValue('difficulty', '2')).toBe('normal');
    // other keys and other values are untouched
    expect(normalizeValue('gamemode', '7')).toBe('7');
    expect(normalizeValue('motd', '1')).toBe('1');
  });

  it('collects the field errors of a validation answer', () => {
    const details = [{ path: 'set.motd', message: 'too long' }, { path: 'set.query.port', message: 'wrong' }];
    expect(fieldErrorsFrom(new ApiError(400, 'VALIDATION_ERROR', 'invalid', details))).toEqual({ fields: ['motd', 'query.port'], other: false });
    expect(fieldErrorsFrom(new ApiError(400, 'VALIDATION_ERROR', 'invalid', [{ path: 'remove', message: 'x' }])).other).toBe(true);
    expect(fieldErrorsFrom(new ApiError(500, 'INTERNAL_ERROR', 'kaputt'))).toEqual({ fields: [], other: true });
  });

  it('accepts plain folder names as level name', () => {
    for (const good of ['world', 'My World', 'world_2']) expect(isValidLevelName(good), good).toBe(true);
    for (const bad of ['', ' world', '..', 'a/b', 'a\\b', 'world.', 'a:b']) expect(isValidLevelName(bad), bad).toBe(false);
  });
});

describe('integration in the server page', () => {
  it('lists the areas in order and opens the world settings from the configuration', async () => {
    setup();
    const user = userEvent.setup();
    window.history.replaceState(null, '', '/servers/srv-1/config');
    render(<App />);
    const nav = await screen.findByRole('navigation', { name: 'Server sections' });
    expect(within(nav).getAllByRole('link').map((link) => link.textContent)).toEqual(['Overview', 'Console', 'Players', 'Mods', 'World & backups', 'Settings']);
    expect(within(nav).getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');
    const parts = screen.getByRole('navigation', { name: 'Parts of Settings' });
    expect(within(parts).getAllByRole('link').map((link) => link.textContent)).toEqual(['General', 'World settings']);
    // the read-only list of other entries is gone; a link leads to the world tab instead
    expect(await screen.findByText(/1 more entry in the file can be viewed and edited in the "World settings" tab/)).toBeInTheDocument();
    expect(screen.queryByText(/display only/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'Open world settings' }));
    expect(await screen.findByRole('region', { name: 'This world' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/servers/srv-1/world');
    expect(within(screen.getByRole('navigation', { name: 'Parts of Settings' })).getByRole('link', { name: 'World settings' })).toHaveAttribute('aria-current', 'page');
  });
});

describe('world tab', () => {
  it('shows the world facts and groups the entries by category', async () => {
    setup();
    render(ui());
    const facts = await screen.findByRole('region', { name: 'This world' });
    expect(facts).toHaveTextContent('World name');
    expect(facts).toHaveTextContent('12345');
    expect(facts).toHaveTextContent('minecraft:normal');
    expect(facts).toHaveTextContent('Survival');
    expect(facts).toHaveTextContent('Easy');
    expect(within(facts).getByText('No')).toBeInTheDocument();

    expect(within(region('World')).getAllByTestId('property-row').map((row) => row.getAttribute('data-key'))).toEqual(['level-name', 'level-seed', 'level-type', 'view-distance']);
    expect(within(region('Gameplay')).getAllByTestId('property-row').map((row) => row.getAttribute('data-key'))).toEqual(['gamemode', 'difficulty', 'hardcore', 'pvp']);
    expect(within(region('Players')).getAllByTestId('property-row')).toHaveLength(2);
    expect(within(region('Network')).getAllByTestId('property-row')).toHaveLength(3);
    expect(within(region('Advanced')).getAllByTestId('property-row')).toHaveLength(1);
    expect(within(region('Other entries')).getAllByTestId('property-row').map((row) => row.getAttribute('data-key'))).toEqual(['my-mod.option']);
  });

  it('labels every field and explains it in one line', async () => {
    setup();
    render(ui());
    await screen.findByRole('region', { name: 'World' });
    const view = rowOf('view-distance');
    expect(within(view).getByLabelText('View distance (chunks)')).toHaveValue(12);
    expect(within(view).getByText(/How many chunks around each player/)).toBeInTheDocument();
    expect(within(view).getByText('view-distance')).toBeInTheDocument();
    expect(view).toHaveTextContent('Default: 10');
    // a known key the file lacks shows its default
    expect(rowOf('hardcore')).toHaveTextContent('not in the file');
    expect(within(rowOf('hardcore')).getByRole('switch', { name: 'Hardcore' })).toHaveAttribute('aria-checked', 'false');
    expect(within(rowOf('gamemode')).getByLabelText('Game mode')).toHaveValue('survival');
    expect(within(rowOf('gamemode')).getByRole('option', { name: 'Creative' })).toBeInTheDocument();
    // an unknown key is shown under its own name
    expect(within(rowOf('my-mod.option')).getByLabelText('my-mod.option')).toHaveValue('7');
    expect(rowOf('my-mod.option')).toHaveTextContent('unknown entry');
  });

  it('offers the suggestions for the world type', async () => {
    setup();
    render(ui());
    await screen.findByRole('region', { name: 'World' });
    const input = within(rowOf('level-type')).getByLabelText('World type');
    const list = document.getElementById(input.getAttribute('list') ?? 'none');
    expect(list?.tagName).toBe('DATALIST');
    expect([...(list?.querySelectorAll('option') ?? [])].map((option) => option.getAttribute('value'))).toEqual(['minecraft:normal', 'minecraft:flat']);
  });

  it('hides secrets until asked', async () => {
    setup();
    const user = userEvent.setup();
    render(ui());
    await screen.findByRole('region', { name: 'Network' });
    const input = within(rowOf('rcon.password')).getByLabelText('RCON password');
    expect(input).toHaveAttribute('type', 'password');
    await user.click(within(rowOf('rcon.password')).getByRole('button', { name: 'RCON password: show or hide value' }));
    expect(input).toHaveAttribute('type', 'text');
    expect(input).toHaveValue('geheim');
  });

  it('shows game mode and difficulty of an old numeric file by their names', async () => {
    setup();
    entries = [...fileEntries().filter((entry) => entry.key !== 'gamemode'), { key: 'gamemode', value: '1', known: true }, { key: 'difficulty', value: '3', known: true }];
    render(ui());
    const facts = await screen.findByRole('region', { name: 'This world' });
    expect(facts).toHaveTextContent('Creative');
    expect(facts).toHaveTextContent('Hard');
    expect(within(rowOf('gamemode')).getByLabelText('Game mode')).toHaveValue('creative');
    expect(within(rowOf('difficulty')).getByLabelText('Difficulty')).toHaveValue('hard');
    expect(screen.getByText('No changes')).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
  });

  it('warns while the server runs that console commands and the next start can overwrite the changes', async () => {
    setup();
    const user = userEvent.setup();
    render(ui(onlineStatus));
    await screen.findByRole('region', { name: 'World' });
    expect(screen.getByText(/can overwrite the changes made here while the server runs/)).toBeInTheDocument();
    expect(screen.getByText(/Please stop the server first/)).toBeInTheDocument();
    await user.click(within(rowOf('pvp')).getByRole('switch', { name: 'PvP' }));
    await user.click(saveButton());
    await waitFor(() => expect(putCalls()).toHaveLength(1));
    expect(screen.getByText(/can overwrite the changes/)).toBeInTheDocument();
  });

  it('starts without the live warning while the server is stopped', async () => {
    setup();
    render(ui());
    await screen.findByRole('region', { name: 'World' });
    expect(screen.queryByText(/can overwrite the changes/)).not.toBeInTheDocument();
  });

  it('shows the live warning after a save that the backend flags as risky', async () => {
    setup({ liveOverwriteRisk: true });
    const user = userEvent.setup();
    render(ui());
    await screen.findByRole('region', { name: 'Gameplay' });
    await user.click(within(rowOf('pvp')).getByRole('switch', { name: 'PvP' }));
    await user.click(saveButton());
    expect(await screen.findByText(/can overwrite the changes made here while the server runs/)).toBeInTheDocument();
  });

  it('saves a switched boolean and nothing else', async () => {
    setup();
    const user = userEvent.setup();
    render(ui());
    await screen.findByRole('region', { name: 'Gameplay' });
    expect(saveButton()).toBeDisabled();
    expect(screen.getByText('No changes')).toBeInTheDocument();
    await user.click(within(rowOf('pvp')).getByRole('switch', { name: 'PvP' }));
    expect(within(rowOf('pvp')).getByText('Changed')).toBeInTheDocument();
    expect(screen.getByText('1 change')).toBeInTheDocument();
    await user.click(saveButton());
    await waitFor(() => expect(putCalls()).toHaveLength(1));
    expect(putCalls()[0]?.body).toEqual({ set: { pvp: 'false' } });
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    expect(within(rowOf('pvp')).getByRole('switch', { name: 'PvP' })).toHaveAttribute('aria-checked', 'false');
    expect(within(rowOf('pvp')).queryByText('Changed')).not.toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
  });

  it('edits an integer and an enum and sends only the changed keys', async () => {
    setup();
    const user = userEvent.setup();
    render(ui());
    await screen.findByRole('region', { name: 'World' });
    await user.clear(within(rowOf('view-distance')).getByLabelText('View distance (chunks)'));
    await user.type(within(rowOf('view-distance')).getByLabelText('View distance (chunks)'), '16');
    await user.selectOptions(within(rowOf('gamemode')).getByLabelText('Game mode'), 'creative');
    // typed back to the original: no longer a change
    await user.clear(within(rowOf('motd')).getByLabelText('MOTD'));
    await user.type(within(rowOf('motd')).getByLabelText('MOTD'), 'x');
    await user.clear(within(rowOf('motd')).getByLabelText('MOTD'));
    await user.type(within(rowOf('motd')).getByLabelText('MOTD'), 'Hello world');
    expect(screen.getByText('2 changes')).toBeInTheDocument();
    await user.click(saveButton());
    await waitFor(() => expect(putCalls()).toHaveLength(1));
    expect(putCalls()[0]?.body).toEqual({ set: { 'view-distance': '16', gamemode: 'creative' } });
  });

  it('checks numbers on the page and blocks saving until they are right', async () => {
    setup();
    const user = userEvent.setup();
    render(ui());
    await screen.findByRole('region', { name: 'World' });
    const input = within(rowOf('view-distance')).getByLabelText('View distance (chunks)');
    await user.clear(input);
    await user.type(input, '99');
    expect(within(rowOf('view-distance')).getByRole('alert')).toHaveTextContent('Enter a whole number from 2 to 32.');
    expect(input).toBeInvalid();
    expect(saveButton()).toBeDisabled();
    expect(screen.getByText('Please fix the marked errors before saving.')).toBeInTheDocument();
    await user.clear(input);
    expect(within(rowOf('view-distance')).getByRole('alert')).toBeInTheDocument();
    await user.type(input, '8');
    expect(within(rowOf('view-distance')).queryByRole('alert')).not.toBeInTheDocument();
    expect(saveButton()).toBeEnabled();
    expect(putCalls()).toHaveLength(0);
  });

  it('refuses a level name that is not a plain folder name', async () => {
    setup();
    const user = userEvent.setup();
    render(ui());
    await screen.findByRole('region', { name: 'World' });
    const input = within(rowOf('level-name')).getByLabelText('World name');
    await user.clear(input);
    await user.type(input, '../etc');
    expect(within(rowOf('level-name')).getByRole('alert')).toHaveTextContent(/plain folder name/);
    expect(saveButton()).toBeDisabled();
  });

  it('shows the validation errors of the backend at the right field and clears them on edit', async () => {
    setup();
    nextPut = () => ({
      status: 400,
      body: { error: { code: 'VALIDATION_ERROR', message: 'The request contains invalid data.', details: [{ path: 'set.motd', message: 'The value of "motd" contains invalid characters.' }] } },
    });
    const user = userEvent.setup();
    render(ui());
    await screen.findByRole('region', { name: 'Network' });
    await user.type(within(rowOf('motd')).getByLabelText('MOTD'), '!');
    await user.click(saveButton());
    expect(await within(rowOf('motd')).findByRole('alert')).toHaveTextContent('Invalid value.');
    expect(screen.queryByText(/invalid characters/)).not.toBeInTheDocument();
    expect(screen.getByText('Some values are invalid. Please correct the marked fields.')).toBeInTheDocument();
    // the edit stays, nothing was saved
    expect(within(rowOf('motd')).getByLabelText('MOTD')).toHaveValue('Hello world!');
    expect(entries.find((entry) => entry.key === 'motd')?.value).toBe('Hello world');
    await user.type(within(rowOf('motd')).getByLabelText('MOTD'), '?');
    expect(within(rowOf('motd')).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the field errors of the backend as the client-side check or a generic line in English too', async () => {
    setup();
    nextPut = () => ({
      status: 400,
      body: { error: { code: 'VALIDATION_ERROR', message: 'The request contains invalid data.', details: [{ path: 'set.motd', message: 'The value of "motd" contains invalid characters.' }] } },
    });
    const user = userEvent.setup();
    render(ui(offlineStatus));
    await screen.findByRole('region', { name: 'Network' });
    await user.type(within(rowOf('motd')).getByLabelText('MOTD'), '!');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await within(rowOf('motd')).findByRole('alert')).toHaveTextContent('Invalid value.');
    expect(screen.queryByText(/invalid characters/)).not.toBeInTheDocument();
    expect(screen.getByText('Some values are invalid. Please correct the marked fields.')).toBeInTheDocument();
  });

  it('shows other failures as an error notice', async () => {
    setup();
    nextPut = () => ({ status: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'An internal error occurred.' } } });
    const user = userEvent.setup();
    render(ui());
    await screen.findByRole('region', { name: 'Gameplay' });
    await user.click(within(rowOf('pvp')).getByRole('switch', { name: 'PvP' }));
    await user.click(saveButton());
    expect(await screen.findByText('The settings were not saved')).toBeInTheDocument();
    expect(screen.getByText('An internal error occurred.')).toBeInTheDocument();
    expect(saveButton()).toBeEnabled();
  });

  it('discards the edits', async () => {
    setup();
    const user = userEvent.setup();
    render(ui());
    await screen.findByRole('region', { name: 'Gameplay' });
    await user.click(within(rowOf('pvp')).getByRole('switch', { name: 'PvP' }));
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(within(rowOf('pvp')).getByRole('switch', { name: 'PvP' })).toHaveAttribute('aria-checked', 'true');
    expect(saveButton()).toBeDisabled();
  });

  it('adds a custom entry and checks its key', async () => {
    setup();
    const user = userEvent.setup();
    render(ui());
    const add = await screen.findByRole('region', { name: 'Add a custom entry' });
    await user.click(within(add).getByRole('button', { name: 'Stage entry' }));
    expect(await within(add).findByText('Please enter a key.')).toBeInTheDocument();
    await user.type(within(add).getByLabelText('Key'), 'bad key!');
    await user.click(within(add).getByRole('button', { name: 'Stage entry' }));
    expect(await within(add).findByText(/Invalid key/)).toBeInTheDocument();
    await user.clear(within(add).getByLabelText('Key'));
    await user.type(within(add).getByLabelText('Key'), 'pvp');
    await user.click(within(add).getByRole('button', { name: 'Stage entry' }));
    expect(await within(add).findByText('This key already exists.')).toBeInTheDocument();
    await user.clear(within(add).getByLabelText('Key'));
    await user.type(within(add).getByLabelText('Key'), 'my-mod.speed');
    await user.type(within(add).getByLabelText('Value'), '3');
    await user.click(within(add).getByRole('button', { name: 'Stage entry' }));

    expect(rowOf('my-mod.speed')).toHaveTextContent('new');
    expect(within(rowOf('my-mod.speed')).getByLabelText('my-mod.speed')).toHaveValue('3');
    expect(screen.getByText('1 change')).toBeInTheDocument();
    await user.click(saveButton());
    await waitFor(() => expect(putCalls()).toHaveLength(1));
    expect(putCalls()[0]?.body).toEqual({ set: { 'my-mod.speed': '3' } });
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    expect(rowKeys()).toContain('my-mod.speed');
    expect(entries.map((entry) => entry.key)).toContain('my-mod.speed');
  });

  it('drops a staged custom entry again without sending it', async () => {
    setup();
    const user = userEvent.setup();
    render(ui());
    const add = await screen.findByRole('region', { name: 'Add a custom entry' });
    await user.type(within(add).getByLabelText('Key'), 'temp.key');
    await user.click(within(add).getByRole('button', { name: 'Stage entry' }));
    await user.click(within(rowOf('temp.key')).getByRole('button', { name: 'Remove entry temp.key' }));
    expect(rowKeys()).not.toContain('temp.key');
    expect(saveButton()).toBeDisabled();
  });

  it('removes an unknown entry on save and can undo it before', async () => {
    setup();
    const user = userEvent.setup();
    render(ui());
    await screen.findByRole('region', { name: 'Other entries' });
    await user.click(within(rowOf('my-mod.option')).getByRole('button', { name: 'Remove entry my-mod.option' }));
    expect(rowOf('my-mod.option')).toHaveTextContent('Will be removed when saving');
    expect(screen.getByText('1 change')).toBeInTheDocument();
    await user.click(within(rowOf('my-mod.option')).getByRole('button', { name: 'Undo removing my-mod.option' }));
    expect(within(rowOf('my-mod.option')).getByLabelText('my-mod.option')).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();

    await user.click(within(rowOf('my-mod.option')).getByRole('button', { name: 'Remove entry my-mod.option' }));
    await user.click(saveButton());
    await waitFor(() => expect(putCalls()).toHaveLength(1));
    expect(putCalls()[0]?.body).toEqual({ remove: ['my-mod.option'] });
    await waitFor(() => expect(rowKeys()).not.toContain('my-mod.option'));
  });

  it('does not offer to remove known keys, least of all the server port', async () => {
    setup();
    render(ui());
    await screen.findByRole('region', { name: 'Network' });
    expect(within(rowOf('server-port')).queryByRole('button')).not.toBeInTheDocument();
    expect(within(rowOf('motd')).queryByRole('button')).not.toBeInTheDocument();
  });

  it('searches by label, key and description', async () => {
    setup();
    const user = userEvent.setup();
    render(ui());
    await screen.findByRole('region', { name: 'World' });
    const search = screen.getByLabelText('Search settings');
    await user.type(search, 'rcon');
    expect(rowKeys()).toEqual(['rcon.password']);
    expect(screen.queryByRole('region', { name: 'World' })).not.toBeInTheDocument();
    await user.clear(search);
    await user.type(search, 'View distance');
    expect(rowKeys()).toEqual(['view-distance']);
    await user.clear(search);
    await user.type(search, 'spawn');
    // matches the description of the spawn protection... not in this catalog, so only the seed text may match
    expect(rowKeys().every((key) => ['level-seed', 'level-name', 'level-type'].includes(key))).toBe(true);
    await user.clear(search);
    await user.type(search, 'does not exist');
    expect(rowKeys()).toEqual([]);
    expect(screen.getByText('No setting matches the search.')).toBeInTheDocument();
  });

  it('can show only the entries that differ from the default', async () => {
    setup();
    const user = userEvent.setup();
    render(ui());
    await screen.findByRole('region', { name: 'World' });
    await user.click(screen.getByRole('checkbox', { name: 'Only differences from the default' }));
    // seed, view distance, motd and the secret differ; the unknown entry has no default
    expect(rowKeys().sort()).toEqual(['level-seed', 'motd', 'my-mod.option', 'rcon.password', 'view-distance'].sort());
    // an edit that makes a row equal to the default keeps it visible while it is a pending change
    await user.clear(within(rowOf('view-distance')).getByLabelText('View distance (chunks)'));
    await user.type(within(rowOf('view-distance')).getByLabelText('View distance (chunks)'), '10');
    expect(rowKeys()).toContain('view-distance');
  });

  it('warns about a new world when the level name changes', async () => {
    setup({ levelNameChanged: true });
    const user = userEvent.setup();
    render(ui());
    await screen.findByRole('region', { name: 'World' });
    const input = within(rowOf('level-name')).getByLabelText('World name');
    await user.clear(input);
    await user.type(input, 'welt2');
    expect(within(rowOf('level-name')).getByText(/A different world name creates a new world on the next start/)).toBeInTheDocument();
    await user.click(saveButton());
    const notice = await screen.findByText(/The world name was changed from "world" to "welt2"/);
    expect(notice).toHaveTextContent('The previous world "world" stays untouched on disk.');
    expect(screen.getByText('New world on the next start')).toBeInTheDocument();
    expect(putCalls()[0]?.body).toEqual({ set: { 'level-name': 'welt2' } });
  });

  it('asks for a restart when the server is running', async () => {
    setup({ restartRequired: true });
    const user = userEvent.setup();
    render(ui(onlineStatus));
    await screen.findByRole('region', { name: 'Gameplay' });
    expect(screen.queryByText('Restart required')).not.toBeInTheDocument();
    await user.click(within(rowOf('pvp')).getByRole('switch', { name: 'PvP' }));
    await user.click(saveButton());
    expect(await screen.findByText('Restart required')).toBeInTheDocument();
  });

  it('explains that the file is created on the first start', async () => {
    setup({ exists: false });
    entries = [];
    render(ui());
    expect(await screen.findByText(/The server\.properties file is created the first time the server starts/)).toBeInTheDocument();
    // all known keys show their defaults
    expect(within(rowOf('view-distance')).getByLabelText('View distance (chunks)')).toHaveValue(10);
    expect(within(region('This world')).getByText('(random)')).toBeInTheDocument();
  });

  it('offers a retry when the entries cannot be loaded', async () => {
    setup();
    api.set('GET /api/properties/catalog', () => ({ status: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'An internal error occurred.' } } }));
    const user = userEvent.setup();
    render(ui());
    expect(await screen.findByText('The world settings could not be loaded')).toBeInTheDocument();
    api.set('GET /api/properties/catalog', () => ({ body: { catalog } }));
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('region', { name: 'World' })).toBeInTheDocument();
  });

  it('renders in English', async () => {
    setup();
    const user = userEvent.setup();
    render(ui(offlineStatus));
    expect(await screen.findByRole('region', { name: 'This world' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Gameplay' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Other entries' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Add a custom entry' })).toBeInTheDocument();
    expect(within(rowOf('view-distance')).getByLabelText('View distance (chunks)')).toBeInTheDocument();
    expect(within(rowOf('view-distance')).getByText(/How many chunks around each player/)).toBeInTheDocument();
    expect(rowOf('view-distance')).toHaveTextContent('Default: 10');
    expect(within(rowOf('gamemode')).getByRole('option', { name: 'Creative' })).toBeInTheDocument();
    expect(screen.getByText('No changes')).toBeInTheDocument();
    await user.click(within(rowOf('pvp')).getByRole('switch', { name: 'PvP' }));
    expect(screen.getByText('1 change')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  });
});
