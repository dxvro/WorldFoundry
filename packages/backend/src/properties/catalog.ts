import { z } from 'zod';
import type { PropertyCatalogEntry, PropertyCategory } from '../contract.js';
import { isValidLevelName } from '../backups/world.js';
import { GAMEMODES, DIFFICULTIES } from './typed.js';

// Known keys of a vanilla server.properties file. Only keys, types and limits live here; the frontend
// supplies the labels. Keys missing from this list are still accepted and kept, they are just "unknown".
const INT_MAX = 2_147_483_647;

const flag = (key: string, category: PropertyCategory, value: boolean): PropertyCatalogEntry => ({
  key,
  type: 'boolean',
  category,
  default: String(value),
});

const int = (key: string, category: PropertyCategory, fallback: number, min: number, max: number): PropertyCatalogEntry => ({
  key,
  type: 'integer',
  category,
  default: String(fallback),
  min,
  max,
});

const text = (key: string, category: PropertyCategory, fallback: string, extra: Partial<PropertyCatalogEntry> = {}): PropertyCatalogEntry => ({
  key,
  type: 'string',
  category,
  default: fallback,
  ...extra,
});

const choice = (key: string, category: PropertyCategory, fallback: string, options: readonly string[]): PropertyCatalogEntry => ({
  key,
  type: 'enum',
  category,
  default: fallback,
  options: [...options],
});

const port = (key: string, category: PropertyCategory, fallback: number): PropertyCatalogEntry => int(key, category, fallback, 1, 65535);

export const PROPERTY_CATALOG: readonly PropertyCatalogEntry[] = [
  // world
  text('level-name', 'world', 'world'),
  text('level-seed', 'world', ''),
  // Vanilla accepts the legacy names DEFAULT, FLAT, LARGEBIOMES and AMPLIFIED as well; a plain string keeps those working
  text('level-type', 'world', 'minecraft:normal', {
    suggestions: ['minecraft:normal', 'minecraft:flat', 'minecraft:large_biomes', 'minecraft:amplified', 'minecraft:single_biome_surface'],
  }),
  text('generator-settings', 'world', '{}'),
  flag('generate-structures', 'world', true),
  int('max-world-size', 'world', 29_999_984, 1, 29_999_984),
  int('spawn-protection', 'world', 16, 0, INT_MAX),
  flag('allow-nether', 'world', true),
  flag('spawn-monsters', 'world', true),
  flag('spawn-animals', 'world', true),
  flag('spawn-npcs', 'world', true),
  int('view-distance', 'world', 10, 2, 32),
  int('simulation-distance', 'world', 10, 3, 32),

  // gameplay
  choice('gamemode', 'gameplay', 'survival', GAMEMODES),
  choice('difficulty', 'gameplay', 'easy', DIFFICULTIES),
  flag('hardcore', 'gameplay', false),
  flag('pvp', 'gameplay', true),
  flag('allow-flight', 'gameplay', false),
  flag('force-gamemode', 'gameplay', false),
  flag('enable-command-block', 'gameplay', false),

  // players
  int('max-players', 'players', 20, 1, 10_000),
  flag('white-list', 'players', false),
  flag('enforce-whitelist', 'players', false),
  flag('online-mode', 'players', true),
  flag('hide-online-players', 'players', false),
  int('op-permission-level', 'players', 4, 0, 4),
  int('player-idle-timeout', 'players', 0, 0, INT_MAX),
  flag('enforce-secure-profile', 'players', true),
  flag('require-resource-pack', 'players', false),
  text('resource-pack', 'players', ''),
  text('resource-pack-sha1', 'players', ''),
  text('resource-pack-prompt', 'players', ''),

  // network
  text('motd', 'network', 'A Minecraft Server'),
  port('server-port', 'network', 25565),
  text('server-ip', 'network', ''),
  flag('enable-status', 'network', true),
  flag('enable-query', 'network', false),
  port('query.port', 'network', 25565),
  flag('enable-rcon', 'network', false),
  port('rcon.port', 'network', 25575),
  text('rcon.password', 'network', '', { secret: true }),
  flag('prevent-proxy-connections', 'network', false),
  int('rate-limit', 'network', 0, 0, INT_MAX),
  int('network-compression-threshold', 'network', 256, -1, INT_MAX),
  flag('accepts-transfers', 'network', false),

  // advanced
  flag('broadcast-console-to-ops', 'advanced', true),
  flag('broadcast-rcon-to-ops', 'advanced', true),
  text('bug-report-link', 'advanced', ''),
  int('entity-broadcast-range-percentage', 'advanced', 100, 10, 1000),
  int('function-permission-level', 'advanced', 2, 1, 4),
  flag('log-ips', 'advanced', true),
  int('max-chained-neighbor-updates', 'advanced', 1_000_000, -1, INT_MAX),
  int('max-tick-time', 'advanced', 60_000, -1, INT_MAX),
  int('pause-when-empty-seconds', 'advanced', 60, -1, INT_MAX),
  flag('sync-chunk-writes', 'advanced', true),
  flag('use-native-transport', 'advanced', true),
  choice('region-file-compression', 'advanced', 'deflate', ['deflate', 'lz4', 'none']),
  text('text-filtering-config', 'advanced', ''),
];

// lookups by key; the secret flag is only a hint for the UI, the API returns that value like any other
const BY_KEY: ReadonlyMap<string, PropertyCatalogEntry> = new Map(PROPERTY_CATALOG.map((entry) => [entry.key, entry]));

export function findProperty(key: string): PropertyCatalogEntry | undefined {
  return BY_KEY.get(key);
}

export const PROPERTY_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
export const MAX_ENTRY_KEYS = 200;
export const MAX_ENTRY_VALUE_LENGTH = 2000;

export type ValueCheck = { ok: true; value: string } | { ok: false; message: string };

const ok = (value: string): ValueCheck => ({ ok: true, value });
const invalid = (message: string): ValueCheck => ({ ok: false, message });

// Checks one value and returns the text to write (integers without leading zeros or plus signs).
// The level name must stay one folder name, because backups and the world import use it as such.
export function checkPropertyValue(key: string, raw: string): ValueCheck {
  if (raw.length > MAX_ENTRY_VALUE_LENGTH || /[\r\n\u0000]/.test(raw)) {
    return invalid(`The value of "${key}" contains invalid characters or is too long (at most ${MAX_ENTRY_VALUE_LENGTH} characters).`);
  }
  if (key === 'level-name' && (raw !== raw.trim() || !isValidLevelName(raw))) {
    return invalid('The world name (level-name) must be a simple folder name: no path components, "..", backslashes or leading/trailing spaces.');
  }
  const entry = findProperty(key);
  if (entry === undefined) return ok(raw);
  switch (entry.type) {
    case 'boolean':
      return raw === 'true' || raw === 'false' ? ok(raw) : invalid(`"${key}" must be true or false.`);
    case 'integer': {
      const value = /^-?\d+$/.test(raw) ? Number(raw) : Number.NaN;
      const min = entry.min ?? -INT_MAX;
      const max = entry.max ?? INT_MAX;
      return value >= min && value <= max ? ok(String(value)) : invalid(`"${key}" must be a whole number from ${min} to ${max}.`);
    }
    case 'enum':
      return (entry.options ?? []).includes(raw) ? ok(raw) : invalid(`"${key}" must be one of the values ${(entry.options ?? []).join(', ')}.`);
    case 'string':
      return ok(raw);
  }
}

// set and remove together, at most MAX_ENTRY_KEYS keys, each key once; the values are checked by checkPropertyValue
export const PropertiesEntriesPatchSchema = z
  .object({
    set: z.record(z.string().regex(PROPERTY_KEY_PATTERN), z.string()).optional(),
    remove: z.array(z.string().regex(PROPERTY_KEY_PATTERN)).optional(),
  })
  .strict()
  .superRefine((patch, ctx) => {
    const set = patch.set ?? {};
    const remove = patch.remove ?? [];
    const count = Object.keys(set).length + remove.length;
    if (count === 0) ctx.addIssue({ code: 'custom', message: 'No property was provided.', path: [] });
    if (count > MAX_ENTRY_KEYS) {
      ctx.addIssue({ code: 'custom', message: `At most ${MAX_ENTRY_KEYS} properties can be changed per request.`, path: [] });
    }
    for (const [key, value] of Object.entries(set)) {
      const check = checkPropertyValue(key, value);
      if (!check.ok) ctx.addIssue({ code: 'custom', message: check.message, path: ['set', key] });
    }
    for (const key of remove) {
      if (Object.hasOwn(set, key)) {
        ctx.addIssue({ code: 'custom', message: `"${key}" cannot be set and removed at the same time.`, path: ['remove'] });
      }
    }
  });

export type PropertiesEntriesPatchInput = z.infer<typeof PropertiesEntriesPatchSchema>;
