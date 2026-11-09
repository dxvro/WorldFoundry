import { z } from 'zod';
import type { PropertiesDocument } from './parser.js';

export const GAMEMODES = ['survival', 'creative', 'adventure', 'spectator'] as const;
export const DIFFICULTIES = ['peaceful', 'easy', 'normal', 'hard'] as const;

export const TYPED_KEYS = [
  'server-port',
  'gamemode',
  'difficulty',
  'white-list',
  'max-players',
  'view-distance',
  'online-mode',
  'motd',
] as const;

export interface TypedProperties {
  'server-port': number;
  gamemode: (typeof GAMEMODES)[number];
  difficulty: (typeof DIFFICULTIES)[number];
  'white-list': boolean;
  'max-players': number;
  'view-distance': number;
  'online-mode': boolean;
  motd: string;
}

export const DEFAULT_PORT = 25565;

export const DEFAULTS: TypedProperties = {
  'server-port': DEFAULT_PORT,
  gamemode: 'survival',
  difficulty: 'easy',
  'white-list': false,
  'max-players': 20,
  'view-distance': 10,
  'online-mode': true,
  motd: 'A Minecraft Server',
};

export const PropertiesPatchSchema = z
  .object({
    'server-port': z.number().int().min(1).max(65535),
    gamemode: z.enum(GAMEMODES),
    difficulty: z.enum(DIFFICULTIES),
    'white-list': z.boolean(),
    'max-players': z.number().int().min(1).max(10_000),
    'view-distance': z.number().int().min(2).max(32),
    'online-mode': z.boolean(),
    motd: z.string().max(500),
  })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'No property was provided.' });

export type PropertiesPatch = z.infer<typeof PropertiesPatchSchema>;

function readInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || !/^-?\d+$/.test(raw.trim())) return fallback;
  const value = Number(raw.trim());
  return value >= min && value <= max ? value : fallback;
}

function readBool(raw: string | undefined, fallback: boolean): boolean {
  const value = raw?.trim().toLowerCase();
  return value === 'true' ? true : value === 'false' ? false : fallback;
}

function readEnum<T extends string>(raw: string | undefined, options: readonly T[], fallback: T): T {
  const value = raw?.trim().toLowerCase();
  if (value === undefined) return fallback;
  const byName = options.find((option) => option === value);
  if (byName !== undefined) return byName;
  // older servers also accept the numeric ids
  return /^\d$/.test(value) ? (options[Number(value)] ?? fallback) : fallback;
}

export function readTyped(doc: PropertiesDocument): TypedProperties {
  return {
    'server-port': readInt(doc.get('server-port'), DEFAULTS['server-port'], 1, 65535),
    gamemode: readEnum(doc.get('gamemode'), GAMEMODES, DEFAULTS.gamemode),
    difficulty: readEnum(doc.get('difficulty'), DIFFICULTIES, DEFAULTS.difficulty),
    'white-list': readBool(doc.get('white-list'), DEFAULTS['white-list']),
    'max-players': readInt(doc.get('max-players'), DEFAULTS['max-players'], 0, 2_147_483_647),
    'view-distance': readInt(doc.get('view-distance'), DEFAULTS['view-distance'], 2, 32),
    'online-mode': readBool(doc.get('online-mode'), DEFAULTS['online-mode']),
    motd: doc.get('motd') ?? DEFAULTS.motd,
  };
}

// Minecraft up to 1.12.2 reads gamemode and difficulty as numbers and silently falls back to the default for a name
export function enumToken(doc: PropertiesDocument, key: 'gamemode' | 'difficulty', value: string, numeric: boolean): string {
  const index = (key === 'gamemode' ? GAMEMODES : DIFFICULTIES).findIndex((option) => option === value);
  const numberedInFile = /^\d$/.test(doc.get(key)?.trim() ?? '');
  return index >= 0 && (numeric || numberedInFile) ? String(index) : value;
}

// writes one value; gamemode and difficulty become numbers where the server version or the file requires it
export function applyValue(doc: PropertiesDocument, key: string, value: string, numericEnums = false): void {
  doc.set(key, key === 'gamemode' || key === 'difficulty' ? enumToken(doc, key, value, numericEnums) : value);
}

export function applyPatch(doc: PropertiesDocument, patch: PropertiesPatch, numericEnums = false): void {
  for (const key of TYPED_KEYS) {
    const value = patch[key];
    if (value === undefined) continue;
    applyValue(doc, key, String(value), numericEnums);
  }
}

export function extraProperties(doc: PropertiesDocument): Record<string, string> {
  const known: readonly string[] = TYPED_KEYS;
  return Object.fromEntries(Object.entries(doc.toRecord()).filter(([key]) => !known.includes(key)));
}
