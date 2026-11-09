import { z } from 'zod';
import { AppError } from '../http/errors.js';
import { dashUuid } from './uuid.js';

export const MOJANG_API = 'https://api.mojang.com';
export const LOOKUP_TIMEOUT_MS = 8000;

const profileSchema = z.object({ id: z.string().regex(/^[0-9a-fA-F]{32}$/), name: z.string().regex(/^\w{1,16}$/) });

export interface Profile {
  uuid: string;
  name: string;
}

export interface MojangOptions {
  fetch: typeof fetch;
  userAgent: string;
  baseUrl?: string;
  timeoutMs?: number;
}

const HINT = 'Alternatively, start the server and add the player there live.';
// params.reason: timeout, unreachable, rate-limited, http (with status) or unexpected
const unreachable = (reason: string, key: string, status?: number): AppError =>
  new AppError(502, 'PLAYER_LOOKUP_FAILED', `${reason} ${HINT}`, undefined, { reason: key, ...(status === undefined ? {} : { status }) });

// Only the player name goes over the wire; the result carries the canonical capitalisation
export async function lookupMojangProfile(name: string, options: MojangOptions): Promise<Profile> {
  const url = `${options.baseUrl ?? MOJANG_API}/users/profiles/minecraft/${encodeURIComponent(name)}`;
  let response: Response;
  try {
    response = await options.fetch(url, {
      headers: { 'User-Agent': options.userAgent, Accept: 'application/json' },
      signal: AbortSignal.timeout(options.timeoutMs ?? LOOKUP_TIMEOUT_MS),
    });
  } catch (error) {
    const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw unreachable(
      timeout ? 'Mojang did not respond in time.' : 'Mojang is not reachable, the UUID of the player could not be determined.',
      timeout ? 'timeout' : 'unreachable',
    );
  }
  if (response.status === 404 || response.status === 204) {
    void response.body?.cancel().catch(() => undefined);
    throw new AppError(404, 'PLAYER_NOT_FOUND', `Player not found: the name "${name}" does not exist at Mojang.`, { name }, { name });
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    throw unreachable(
      response.status === 429 ? 'Mojang is currently rate limiting requests.' : `Mojang did not answer the request (HTTP ${response.status}).`,
      response.status === 429 ? 'rate-limited' : 'http',
      response.status === 429 ? undefined : response.status,
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw unreachable('Mojang returned an unexpected response.', 'unexpected');
  }
  const parsed = profileSchema.safeParse(payload);
  if (!parsed.success) throw unreachable('Mojang returned an unexpected response.', 'unexpected');
  return { uuid: dashUuid(parsed.data.id), name: parsed.data.name };
}
