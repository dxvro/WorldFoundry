import { createHash, timingSafeEqual } from 'node:crypto';
import { posix } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DEFAULT_COST, hashPassword, validateNewPassword, verifyPassword, type ScryptCost } from '../auth/password.js';
import type { AuthStatus } from '../contract.js';
import { AppError } from './errors.js';
import { dropUpgradeAfterResponse } from './upgrade.js';

export const SESSION_COOKIE = 'cm_session';
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 3600;

// Keys are "METHOD route-pattern" of the matched route, never the requested path, so percent-encoding or
// dot segments cannot turn a protected route into a public one. Every other matched route needs a login.
// The last four entries are the catch-all patterns of a static frontend (Phase 4).
const PUBLIC_ROUTES: ReadonlySet<string> = new Set([
  'GET /api/health',
  'HEAD /api/health',
  'POST /api/auth/login',
  'GET /api/auth/status',
  'POST /api/auth/logout',
  'GET /',
  'HEAD /',
  'GET /*',
  'HEAD /*',
]);

const CATCH_ALL_ROUTES: ReadonlySet<string> = new Set(['GET /*', 'HEAD /*']);

// Unmatched requests are answered 404, but anything that could be meant as an API path (after decoding
// and normalising) is treated as protected, so a probe cannot tell which API paths exist.
export function targetsApi(url: string): boolean {
  let path = url.split('?')[0] ?? '';
  try {
    path = decodeURIComponent(path);
  } catch {
    return true;
  }
  const normalized = posix.normalize(path.replaceAll('\\', '/')).toLowerCase();
  return normalized === '/api' || normalized.startsWith('/api/');
}

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const raw of (header ?? '').split(';')) {
    const part = raw.trim();
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    let value = part.slice(index + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      cookies[name] ??= decodeURIComponent(value);
    } catch {
      cookies[name] ??= value;
    }
  }
  return cookies;
}

export interface LoginLimiterOptions {
  maxFailures?: number;
  windowMs?: number;
  now?: () => number;
}

interface Attempts {
  failures: number;
  windowStart: number;
}

export class LoginLimiter {
  private readonly attempts = new Map<string, Attempts>();
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(options: LoginLimiterOptions = {}) {
    this.maxFailures = options.maxFailures ?? 5;
    this.windowMs = options.windowMs ?? 5 * 60_000;
    this.now = options.now ?? Date.now;
  }

  // seconds until the next attempt is allowed, 0 if allowed now
  retryAfterSeconds(key: string): number {
    const entry = this.attempts.get(key);
    if (entry === undefined) return 0;
    const remaining = entry.windowStart + this.windowMs - this.now();
    if (remaining <= 0) {
      this.attempts.delete(key);
      return 0;
    }
    return entry.failures >= this.maxFailures ? Math.ceil(remaining / 1000) : 0;
  }

  recordFailure(key: string): void {
    if (this.attempts.size > 1000) this.prune();
    const entry = this.attempts.get(key);
    if (entry === undefined || entry.windowStart + this.windowMs <= this.now()) {
      this.attempts.set(key, { failures: 1, windowStart: this.now() });
    } else {
      entry.failures++;
    }
  }

  reset(key: string): void {
    this.attempts.delete(key);
  }

  private prune(): void {
    for (const [key, entry] of this.attempts) {
      if (entry.windowStart + this.windowMs <= this.now()) this.attempts.delete(key);
    }
  }
}

// Where the password record lives (the database); tests and standalone use run without one
export interface CredentialSource {
  load(): Promise<string | null>;
  save(record: string): Promise<void>;
}

export interface AuthOptions {
  // AUTH_TOKEN of the config file: the machine credential (Authorization: Bearer) and the initial web password
  token: string | undefined;
  limiter?: LoginLimiter;
  failureDelayMs?: number;
  store?: CredentialSource;
  cost?: ScryptCost;
  // how long a loaded password record counts as current (a reset from the command line shows up within this time)
  refreshMs?: number;
  now?: () => number;
}

export type CredentialKind = AuthStatus['credential'];

export class Auth {
  private readonly tokenDigest: Buffer | null;
  private readonly token: string | undefined;
  private readonly store: CredentialSource | null;
  private readonly cost: ScryptCost;
  private readonly refreshMs: number;
  private readonly now: () => number;
  private record: string | null = null;
  private loaded = false;
  private lastRefresh = Number.NEGATIVE_INFINITY;
  private refreshing: Promise<void> | null = null;
  private readonly listeners = new Set<() => void>();
  readonly limiter: LoginLimiter;
  readonly failureDelayMs: number;

  constructor(options: AuthOptions) {
    this.token = options.token;
    this.tokenDigest = options.token === undefined ? null : digest(options.token);
    this.store = options.store ?? null;
    this.cost = options.cost ?? DEFAULT_COST;
    this.refreshMs = options.refreshMs ?? 1000;
    this.now = options.now ?? Date.now;
    this.limiter = options.limiter ?? new LoginLimiter();
    this.failureDelayMs = options.failureDelayMs ?? 400;
  }

  get enabled(): boolean {
    return this.tokenDigest !== null || this.record !== null;
  }

  // what the login form asks for: a password chosen in the UI replaces the token as the web login
  get credential(): CredentialKind {
    if (this.record !== null) return 'password';
    return this.tokenDigest === null ? 'none' : 'token';
  }

  // Reads the stored password record. Another process (the reset command) may have changed it: when the record
  // differs, every session and open socket of the old one is revoked.
  refresh(): Promise<void> {
    if (this.store === null) return Promise.resolve();
    this.refreshing ??= (async () => {
      try {
        const record = await this.store?.load();
        this.lastRefresh = this.now();
        if (record === undefined) return;
        const changed = this.loaded && record !== this.record;
        this.record = record;
        this.loaded = true;
        if (changed) this.notify();
      } catch {
        // an unreadable database keeps the last known state
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  async refreshIfStale(): Promise<void> {
    if (this.store !== null && (!this.loaded || this.now() - this.lastRefresh >= this.refreshMs)) await this.refresh();
  }

  onCredentialChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // a faulty subscriber must not stop the others
      }
    }
  }

  // The machine credential: Authorization: Bearer <AUTH_TOKEN>. It keeps working after a password was chosen.
  verifyToken(candidate: string): boolean {
    return this.tokenDigest !== null && timingSafeEqual(digest(candidate), this.tokenDigest);
  }

  // The web login: the stored password when there is one, otherwise the token
  async verifyLogin(candidate: string): Promise<boolean> {
    await this.refresh();
    if (this.record !== null) return verifyPassword(candidate, this.record);
    return this.verifyToken(candidate);
  }

  async setPassword(password: string): Promise<void> {
    if (this.store === null) throw new Error('No store for the password is available.');
    const record = await hashPassword(password, this.cost);
    await this.store.save(record);
    this.record = record;
    this.loaded = true;
    this.lastRefresh = this.now();
    this.notify();
  }

  // The session cookie derives from whatever the web login currently is. A new password has a new salt, so every
  // cookie of the old one stops working at once.
  sessionValue(): string {
    const material = this.record !== null ? `pw:${this.record}` : this.token;
    return material === undefined ? '' : digest(`worldfoundry-session:${material}`).toString('hex');
  }

  private verifySession(candidate: string): boolean {
    const expected = this.sessionValue();
    return expected !== '' && timingSafeEqual(digest(candidate), digest(expected));
  }

  isAuthenticated(request: FastifyRequest): boolean {
    if (!this.enabled) return true;
    const header = request.headers.authorization;
    if (header !== undefined) {
      const match = /^Bearer\s+(.+)$/i.exec(header);
      if (match?.[1] !== undefined && this.verifyToken(match[1].trim())) return true;
    }
    const cookie = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    return cookie !== undefined && this.verifySession(cookie);
  }

  loginCookie(): string {
    return `${SESSION_COOKIE}=${this.sessionValue()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`;
  }

  clearCookie(): string {
    return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
  }
}

const loginBody = z
  .object({ token: z.string().min(1).max(500).optional(), password: z.string().min(1).max(500).optional() })
  .refine((value) => value.token !== undefined || value.password !== undefined, { message: 'Password is missing' });
const passwordBody = z.object({ currentPassword: z.string().max(500).optional(), newPassword: z.string().max(500) });
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function registerAuth(app: FastifyInstance, auth: Auth): void {
  app.addHook('onRequest', async (request, reply) => {
    await auth.refreshIfStale();
    if (!auth.enabled || auth.isAuthenticated(request)) return;
    if (request.is404) {
      if (!targetsApi(request.url)) return;
    } else {
      const route = `${request.method} ${request.routeOptions.url ?? ''}`;
      // the static catch-all also matches /api/... paths that have no route of their own; those stay protected
      if (PUBLIC_ROUTES.has(route) && !(CATCH_ALL_ROUTES.has(route) && targetsApi(request.url))) return;
    }
    dropUpgradeAfterResponse(request, reply);
    throw new AppError(401, 'UNAUTHORIZED', 'Sign-in required. Please sign in.');
  });

  const status = (request: FastifyRequest): AuthStatus => ({
    authRequired: auth.enabled,
    authenticated: auth.isAuthenticated(request),
    credential: auth.credential,
  });

  const throttle = (request: FastifyRequest, reply: FastifyReply): void => {
    const retryAfter = auth.limiter.retryAfterSeconds(request.ip);
    if (retryAfter > 0) {
      void reply.header('Retry-After', String(retryAfter));
      throw new AppError(429, 'TOO_MANY_ATTEMPTS', `Too many failed sign-in attempts. Please try again in ${retryAfter} seconds.`, {
        retryAfterSeconds: retryAfter,
      }, { seconds: retryAfter });
    }
  };

  app.get('/api/auth/status', async (request): Promise<AuthStatus> => status(request));

  app.post('/api/auth/login', async (request, reply) => {
    const body = loginBody.parse(request.body);
    const candidate = body.password ?? body.token ?? '';
    if (!auth.enabled) return { authRequired: false, authenticated: true, credential: 'none' } satisfies AuthStatus;
    throttle(request, reply);
    if (!(await auth.verifyLogin(candidate))) {
      auth.limiter.recordFailure(request.ip);
      await wait(auth.failureDelayMs);
      throw new AppError(401, 'INVALID_TOKEN', auth.credential === 'password' ? 'The password is invalid.' : 'The access token is invalid.');
    }
    auth.limiter.reset(request.ip);
    void reply.header('Set-Cookie', auth.loginCookie());
    return { authRequired: true, authenticated: true, credential: auth.credential } satisfies AuthStatus;
  });

  // Choose or change the web password. With a login in place the current password (or, before the first change,
  // the access token) must be given again, and a wrong one counts like a wrong login. Success revokes every other
  // session: the cookie value follows the password, and the response carries the new one for this browser.
  app.post('/api/auth/password', async (request, reply) => {
    const body = passwordBody.parse(request.body ?? {});
    const problem = validateNewPassword(body.newPassword);
    if (problem !== null) throw new AppError(422, 'PASSWORD_TOO_WEAK', problem);
    await auth.refresh();
    if (auth.enabled) {
      throttle(request, reply);
      if (body.currentPassword === undefined || !(await auth.verifyLogin(body.currentPassword))) {
        auth.limiter.recordFailure(request.ip);
        await wait(auth.failureDelayMs);
        throw new AppError(403, 'CURRENT_PASSWORD_WRONG', auth.credential === 'password' ? 'The current password is wrong.' : 'The current password (or the access token) is wrong.');
      }
      auth.limiter.reset(request.ip);
      if (body.currentPassword === body.newPassword) {
        throw new AppError(422, 'PASSWORD_UNCHANGED', 'The new password must differ from the current one.');
      }
    }
    await auth.setPassword(body.newPassword);
    void reply.header('Set-Cookie', auth.loginCookie());
    return { authRequired: true, authenticated: true, credential: 'password' } satisfies AuthStatus;
  });

  app.post('/api/auth/logout', async (_request, reply) => {
    void reply.header('Set-Cookie', auth.clearCookie());
    return { authenticated: false };
  });
}
