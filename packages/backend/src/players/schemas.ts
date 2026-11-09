import { isIP } from 'node:net';
import { z } from 'zod';

// Player-name rules; the frontend can mirror these 1:1.
// - PLAYER_NAME (strict): Mojang accounts (online-mode=true): 1 to 16 letters, digits or underscore.
// - PLAYER_NAME_LENIENT: 1 to 32 printable ASCII characters without any whitespace or control character (so a name can
//   never split or extend a console command), not starting with "@" (target selectors). It is used for names on
//   offline-mode servers, for Floodgate/Geyser Bedrock names (they start with "." by default) and for every removal,
//   so that entries that are already stuck in a list can be taken out again.
// - Adding: lenient when online-mode=false or the name starts with FLOODGATE_PREFIX, strict otherwise (isAddableName).
export const PLAYER_NAME = /^[A-Za-z0-9_]{1,16}$/;
export const PLAYER_NAME_LENIENT = /^(?!@)[\x21-\x7e]{1,32}$/;
export const FLOODGATE_PREFIX = '.';
export const MAX_REASON_LENGTH = 200;

export function isAddableName(name: string, onlineMode: boolean): boolean {
  if (!PLAYER_NAME_LENIENT.test(name)) return false;
  return !onlineMode || name.startsWith(FLOODGATE_PREFIX) || PLAYER_NAME.test(name);
}

// Shape check for bodies and DELETE paths; the online-mode dependent rule for additions is applied by the service
export const nameSchema = z
  .string()
  .trim()
  .regex(PLAYER_NAME_LENIENT, 'Invalid player name (1 to 32 visible ASCII characters without spaces, not starting with "@").');

export const ipSchema = z
  .string()
  .trim()
  .max(45)
  .refine((value) => !value.includes('%') && isIP(value) !== 0, 'Invalid IP address (IPv4 or IPv6).');

const reasonSchema = z
  .string()
  .trim()
  .max(MAX_REASON_LENGTH, `The reason must be at most ${MAX_REASON_LENGTH} characters long.`)
  .refine((value) => !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value), 'The reason must not contain line breaks or control characters.')
  .optional();

export const WhitelistBodySchema = z.object({ name: nameSchema }).strict();
export const OpBodySchema = z
  .object({ name: nameSchema, level: z.number().int().min(1).max(4).optional(), bypassesPlayerLimit: z.boolean().optional() })
  .strict();
export const BanBodySchema = z.object({ name: nameSchema, reason: reasonSchema }).strict();
export const IpBanBodySchema = z.object({ ip: ipSchema, reason: reasonSchema }).strict();

export type OpInput = z.infer<typeof OpBodySchema>;
export const WhitelistEnabledBodySchema = z.object({ enabled: z.boolean() }).strict();
