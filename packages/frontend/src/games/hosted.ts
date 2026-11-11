import type { GameId, ServerDto } from '@worldfoundry/backend/contract';

// The fields of the newer games: what the create wizard asks and what the settings page lets change later.
// The labels are in i18n/locales/en/hosted.ts under the same keys; the backend checks every value again.
export type HostedGame = 'asa' | 'valheim' | 'sevendays' | 'palworld' | 'terraria';
export const HOSTED_GAMES: readonly HostedGame[] = ['asa', 'valheim', 'sevendays', 'palworld', 'terraria'];
export const isHosted = (game: GameId): game is HostedGame => (HOSTED_GAMES as readonly string[]).includes(game);

export type FieldValue = string | number | boolean;

export interface HostedField {
  key: string;
  kind: 'text' | 'password' | 'number' | 'select' | 'toggle';
  // select: the values in order; the labels come from hosted.options[optionsKey]
  options?: readonly (string | number)[];
  optionsKey?: 'size' | 'difficulty' | 'sevendaysWorld' | 'worldSize' | 'asaMap';
  min?: number;
  max?: number;
  default: FieldValue;
  // asked when the server is created / changeable later
  create: boolean;
  edit: boolean;
  // shown only when another field has this value (7 Days to Die: seed and size for random worlds)
  when?: { key: string; value: FieldValue };
}

const players = (fallback: number, max: number): HostedField => ({ key: 'maxPlayers', kind: 'number', min: 1, max, default: fallback, create: true, edit: true });
const password = (edit = true): HostedField => ({ key: 'password', kind: 'password', default: '', create: true, edit });

export const HOSTED_FIELDS: Record<HostedGame, readonly HostedField[]> = {
  asa: [
    { key: 'map', kind: 'select', options: ['TheIsland_WP', 'ScorchedEarth_WP', 'TheCenter_WP', 'Aberration_WP', 'Extinction_WP', 'Astraeos_WP', 'Ragnarok_WP', 'Valguero_WP'], optionsKey: 'asaMap', default: 'TheIsland_WP', create: true, edit: true },
    players(20, 127),
    password(),
  ],
  valheim: [
    { key: 'world', kind: 'text', default: 'Dedicated', create: true, edit: true },
    { key: 'password', kind: 'password', default: '', create: true, edit: true },
    { key: 'public', kind: 'toggle', default: false, create: true, edit: true },
    { key: 'crossplay', kind: 'toggle', default: false, create: true, edit: true },
  ],
  sevendays: [
    { key: 'world', kind: 'select', options: ['Navezgane', 'RWG'], optionsKey: 'sevendaysWorld', default: 'Navezgane', create: true, edit: true },
    { key: 'gameName', kind: 'text', default: 'MyGame', create: true, edit: true },
    { key: 'seed', kind: 'text', default: 'WorldFoundry', create: true, edit: true, when: { key: 'world', value: 'RWG' } },
    { key: 'worldSize', kind: 'select', options: [6144, 8192, 10240], optionsKey: 'worldSize', default: 6144, create: true, edit: true, when: { key: 'world', value: 'RWG' } },
    players(8, 64),
    password(),
  ],
  palworld: [players(16, 32), password(), { key: 'public', kind: 'toggle', default: false, create: true, edit: true }],
  terraria: [
    { key: 'world', kind: 'text', default: 'World', create: true, edit: true },
    { key: 'size', kind: 'select', options: [1, 2, 3], optionsKey: 'size', default: 2, create: true, edit: true },
    { key: 'difficulty', kind: 'select', options: [0, 1, 2, 3], optionsKey: 'difficulty', default: 0, create: true, edit: true },
    players(8, 255),
    password(),
  ],
};

export function hostedSettings(server: Pick<ServerDto, 'gameSettings'>): Record<string, unknown> {
  try {
    const parsed = JSON.parse(server.gameSettings) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export const visible = (field: HostedField, values: Record<string, FieldValue>): boolean => field.when === undefined || values[field.when.key] === field.when.value;
