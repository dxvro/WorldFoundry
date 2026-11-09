import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_COST, generatePassword, hashPassword, parseRecord, validateNewPassword, verifyPassword } from '../src/auth/password.js';
import { PasswordStore } from '../src/auth/store.js';
import { runCli, type CliIo } from '../src/cli.js';
import { openDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { LoginLimiter } from '../src/http/auth.js';
import { ServerEnv, scratchDir, waitFor } from './server-env.js';

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

const TOKEN = 'machine-token-123';
const FAST = { N: 1024, r: 8, p: 1 };

describe('password hashing', () => {
  it('stores a salted scrypt record that verifies only the right password', async () => {
    const record = await hashPassword('a very good password', FAST);
    expect(record).toMatch(/^scrypt\$1024\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(record).not.toContain('good');
    expect(await verifyPassword('a very good password', record)).toBe(true);
    expect(await verifyPassword('a very good password ', record)).toBe(false);
    expect(await verifyPassword('', record)).toBe(false);
    // a new salt every time
    expect(await hashPassword('a very good password', FAST)).not.toBe(record);
  });

  it('uses the strong default cost and handles the memory limit of scrypt', async () => {
    expect(DEFAULT_COST).toEqual({ N: 32768, r: 8, p: 1 });
    const record = await hashPassword('Password for the test', DEFAULT_COST);
    expect(parseRecord(record)?.cost).toEqual(DEFAULT_COST);
    expect(await verifyPassword('Password for the test', record)).toBe(true);
    expect(await verifyPassword('another password!!', record)).toBe(false);
  }, 20_000);

  it('treats equivalent unicode spellings as the same password', async () => {
    const record = await hashPassword('Käse-Brötchen-2026', FAST);
    expect(await verifyPassword('Käse-Brötchen-2026', record)).toBe(true);
  });

  it('rejects damaged or hostile records instead of crashing or allocating gigabytes', async () => {
    for (const record of ['', 'scrypt', 'bcrypt$1$2$3$a$b', 'scrypt$1024$8$1$AAAA$AAAA', 'scrypt$1048576$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA', 'scrypt$1000$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA', 'scrypt$x$y$z$a$b']) {
      expect(await verifyPassword('anything123', record), record).toBe(false);
    }
  });

  it('enforces the password policy', () => {
    expect(validateNewPassword('short')).toContain('at least 10');
    expect(validateNewPassword('aaaaaaaaaaaa')).toContain('too simple');
    expect(validateNewPassword('x'.repeat(201))).toContain('at most');
    expect(validateNewPassword('a long password')).toBeNull();
    expect(validateNewPassword('0123456789')).toBeNull();
  });

  it('generates readable random passwords', () => {
    const a = generatePassword();
    expect(a).toHaveLength(16);
    expect(a).toMatch(/^[a-km-zA-HJ-NP-Z2-9]+$/);
    expect(generatePassword()).not.toBe(a);
    expect(validateNewPassword(a)).toBeNull();
  });
});

describe('web password and machine token', () => {
  let env: ServerEnv;
  const bearer = { Authorization: `Bearer ${TOKEN}` };

  async function start(options: { token?: string | null } = {}): Promise<void> {
    env = await ServerEnv.create(options.token === null ? {} : { authToken: options.token ?? TOKEN });
  }
  afterEach(async () => {
    await env.close();
  });

  const login = (secret: string, extra: Record<string, string> = {}) => env.call<ErrorBody & { credential?: string }>('POST', '/api/auth/login', { token: secret }, extra);
  const cookieOf = (headers: Record<string, unknown>): string => {
    const header = headers['set-cookie'];
    const text = Array.isArray(header) ? String(header[0]) : String(header);
    return text.split(';')[0] ?? '';
  };
  const change = (body: Record<string, unknown>, headers: Record<string, string>) => env.call<ErrorBody & { credential?: string }>('POST', '/api/auth/password', body, headers);

  it('starts with the token as the web password and reports which credential the login asks for', async () => {
    await start();
    expect((await env.call('GET', '/api/auth/status')).body).toEqual({ authRequired: true, authenticated: false, credential: 'token' });
    const ok = await login(TOKEN);
    expect(ok.status).toBe(200);
    expect(cookieOf(ok.headers)).toMatch(/^cm_session=[0-9a-f]{64}$/);
    expect((await env.call('GET', '/api/servers', undefined, { Cookie: cookieOf(ok.headers) })).status).toBe(200);
  });

  it('changes the password: needs the current one, switches the web login and invalidates other sessions', async () => {
    await start();
    const sessionA = cookieOf((await login(TOKEN)).headers);
    const sessionB = cookieOf((await login(TOKEN)).headers);
    expect(sessionA).toBe(sessionB); // same credential, same cookie value: this is what the change revokes

    const res = await change({ currentPassword: TOKEN, newPassword: 'a new password' }, { Cookie: sessionA });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authRequired: true, authenticated: true, credential: 'password' });
    const fresh = cookieOf(res.headers);
    expect(fresh).toMatch(/^cm_session=[0-9a-f]{64}$/);
    expect(fresh).not.toBe(sessionA);

    // the old cookie (own earlier cookie and "other browsers" alike) is dead, the new one works
    expect((await env.call<ErrorBody>('GET', '/api/servers', undefined, { Cookie: sessionB })).status).toBe(401);
    expect((await env.call('GET', '/api/servers', undefined, { Cookie: fresh })).status).toBe(200);
    expect((await env.call('GET', '/api/auth/status', undefined, { Cookie: fresh })).body).toEqual({ authRequired: true, authenticated: true, credential: 'password' });

    // the token no longer opens the web login, the password does
    const refused = await login(TOKEN);
    expect([refused.status, refused.body.error.code, refused.body.error.message]).toEqual([401, 'INVALID_TOKEN', 'The password is invalid.']);
    expect((await login('a new password')).status).toBe(200);
    expect((await env.call('POST', '/api/auth/login', { password: 'a new password' })).status).toBe(200);
  });

  it('refuses a wrong current password and stores nothing', async () => {
    await start();
    const cookie = cookieOf((await login(TOKEN)).headers);
    const wrong = await change({ currentPassword: 'wrong-wrong', newPassword: 'a new password' }, { Cookie: cookie });
    expect([wrong.status, wrong.body.error.code]).toEqual([403, 'CURRENT_PASSWORD_WRONG']);
    const missing = await change({ newPassword: 'a new password' }, { Cookie: cookie });
    expect([missing.status, missing.body.error.code]).toEqual([403, 'CURRENT_PASSWORD_WRONG']);
    expect(await new PasswordStore(env.t.db).load()).toBeNull();
    expect((await login(TOKEN)).status).toBe(200);
    // a session cookie alone is not enough to take the account over
    expect((await env.call('GET', '/api/servers', undefined, { Cookie: cookie })).status).toBe(200);
  });

  it('validates the new password and requires it to differ', async () => {
    await start();
    const cookie = cookieOf((await login(TOKEN)).headers);
    const short = await change({ currentPassword: TOKEN, newPassword: 'short' }, { Cookie: cookie });
    expect([short.status, short.body.error.code]).toEqual([422, 'PASSWORD_TOO_WEAK']);
    const same = await change({ currentPassword: TOKEN, newPassword: TOKEN }, { Cookie: cookie });
    expect([same.status, same.body.error.code]).toEqual([422, 'PASSWORD_UNCHANGED']);
    expect((await change({}, { Cookie: cookie })).status).toBe(400);
  });

  it('rate limits wrong current passwords like logins, per IP, and the limit also covers the login', async () => {
    await start();
    const cookie = cookieOf((await login(TOKEN)).headers);
    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await change({ currentPassword: `wrong-${attempt}-xx`, newPassword: 'a new password' }, { Cookie: cookie })).status).toBe(403);
    }
    const blocked = await change({ currentPassword: TOKEN, newPassword: 'a new password' }, { Cookie: cookie });
    expect([blocked.status, blocked.body.error.code]).toEqual([429, 'TOO_MANY_ATTEMPTS']);
    expect(blocked.headers['retry-after']).toBeDefined();
    expect((await login(TOKEN)).status).toBe(429);
    expect(await new PasswordStore(env.t.db).load()).toBeNull();
  });

  it('keeps the token working as the machine credential (Bearer) after the password changed', async () => {
    await start();
    const cookie = cookieOf((await login(TOKEN)).headers);
    expect((await change({ currentPassword: TOKEN, newPassword: 'a new password' }, { Cookie: cookie })).status).toBe(200);
    expect((await env.call('GET', '/api/servers', undefined, bearer)).status).toBe(200);
    expect((await env.call('GET', '/api/system/update', undefined, bearer)).status).toBe(200);
    const health = await env.call<{ version?: string }>('GET', '/api/health', undefined, bearer);
    expect(health.body.version).toBeDefined();
    expect((await env.call('GET', '/api/servers', undefined, { Authorization: 'Bearer wrong-wrong' })).status).toBe(401);
    // the new password is not an API token
    expect((await env.call('GET', '/api/servers', undefined, { Authorization: 'Bearer a new password' })).status).toBe(401);
  });

  it('lets an open installation (no token) choose a first password, which switches the login on', async () => {
    await start({ token: null });
    expect((await env.call('GET', '/api/auth/status')).body).toEqual({ authRequired: false, authenticated: true, credential: 'none' });
    expect((await env.call('GET', '/api/servers')).status).toBe(200);
    const set = await change({ newPassword: 'my first password' }, {});
    expect(set.status).toBe(200);
    expect(set.body.credential).toBe('password');
    const cookie = cookieOf(set.headers);
    expect((await env.call('GET', '/api/servers')).status).toBe(401);
    expect((await env.call('GET', '/api/servers', undefined, { Cookie: cookie })).status).toBe(200);
    expect((await login('my first password')).status).toBe(200);
    expect((await login('wrong password')).status).toBe(401);
  });

  it('needs a login to change the password at all', async () => {
    await start();
    const res = await change({ currentPassword: TOKEN, newPassword: 'a new password' }, {});
    expect([res.status, res.body.error.code]).toEqual([401, 'UNAUTHORIZED']);
  });

  it('closes open sockets when the password changes (they reconnect with the new cookie)', async () => {
    await start();
    await env.app.listen({ host: '127.0.0.1', port: 0 });
    const port = (env.app.server.address() as { port: number }).port;
    const cookie = cookieOf((await login(TOKEN)).headers);
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/events`, { headers: { Cookie: cookie } } as never);
    let closeCode: number | null = null;
    socket.onclose = (event) => {
      closeCode = event.code;
    };
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error('Socket refused'));
    });
    expect((await change({ currentPassword: TOKEN, newPassword: 'a new password' }, { Cookie: cookie })).status).toBe(200);
    await waitFor(() => closeCode !== null || undefined);
    expect(closeCode).toBe(4401);
  });

  it('notices a password changed from outside (reset command) without a restart and revokes the sessions', async () => {
    await start();
    const cookie = cookieOf((await login(TOKEN)).headers);
    expect((await env.call('GET', '/api/servers', undefined, { Cookie: cookie })).status).toBe(200);
    // what the reset command does: write a new record straight into the database
    await new PasswordStore(env.t.db).save(await hashPassword('Emergency-Password-1', FAST));
    expect((await env.call('GET', '/api/servers', undefined, { Cookie: cookie })).status).toBe(401);
    expect((await login(TOKEN)).status).toBe(401);
    expect((await login('Emergency-Password-1')).status).toBe(200);
    expect((await env.call('GET', '/api/servers', undefined, bearer)).status).toBe(200);
  });

  it('keeps the limiter independent of the password hashing cost', () => {
    const limiter = new LoginLimiter({ maxFailures: 2, windowMs: 1000, now: () => 0 });
    limiter.recordFailure('a');
    limiter.recordFailure('a');
    expect(limiter.retryAfterSeconds('a')).toBe(1);
  });
});

describe('command line reset', () => {
  let dir: string;
  let out: string[];
  let err: string[];
  let stdin: string;

  async function setup(createDatabase = true): Promise<CliIo> {
    dir = await scratchDir('cli-');
    await writeFile(path.join(dir, 'worldfoundry.env'), '', 'utf8');
    if (createDatabase) {
      const handle = await openDb(path.join(dir, 'worldfoundry.db'));
      await runMigrations(handle.db);
      handle.close();
    }
    out = [];
    err = [];
    stdin = '';
    return {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      readStdin: async () => stdin,
      env: { DATA_DIR: dir, CONFIG_FILE: path.join(dir, 'worldfoundry.env') },
    };
  }

  async function storedRecord(): Promise<string | null> {
    const handle = await openDb(path.join(dir, 'worldfoundry.db'));
    try {
      return await new PasswordStore(handle.db).load();
    } finally {
      handle.close();
    }
  }

  it('writes a new random password and prints it once', async () => {
    const io = await setup();
    expect(await runCli(['reset-password'], io)).toBe(0);
    expect(err).toEqual([]);
    const printed = /New password: (\S+)/.exec(out.join('\n'))?.[1];
    expect(printed).toHaveLength(16);
    expect(out.join('\n')).toContain('access token (AUTH_TOKEN) for scripts and the API is unchanged');
    expect(await verifyPassword(printed as string, (await storedRecord()) as string)).toBe(true);
  });

  it('takes the password from standard input and does not print it', async () => {
    const io = await setup();
    stdin = 'my own password\r\nsecond line\n';
    expect(await runCli(['reset-password', '--password-stdin'], io)).toBe(0);
    expect(out.join('\n')).not.toContain('my own');
    expect(await verifyPassword('my own password', (await storedRecord()) as string)).toBe(true);
  });

  it('refuses weak input, unknown options, unknown commands and a missing database', async () => {
    const io = await setup();
    stdin = 'short\n';
    expect(await runCli(['reset-password', '--password-stdin'], io)).toBe(1);
    expect(err.join('\n')).toContain('at least 10');
    expect(await storedRecord()).toBeNull();
    expect(await runCli(['reset-password', '--bogus'], io)).toBe(2);
    expect(await runCli(['frob'], io)).toBe(2);
    expect(await runCli(['help'], io)).toBe(0);
    const empty = await setup(false);
    err.length = 0;
    expect(await runCli(['reset-password'], empty)).toBe(1);
    expect(err.join('\n')).toContain('does not exist');
  });

  it('changes what a running application accepts: new password valid, old sessions and old password dead', async () => {
    // the application and the command line share one database file; the running app notices the new record by itself
    const env = await ServerEnv.create({ authToken: TOKEN });
    try {
      const first = await env.call('POST', '/api/auth/login', { token: TOKEN });
      const cookie = String(first.headers['set-cookie']).split(';')[0] ?? '';
      expect((await env.call('GET', '/api/servers', undefined, { Cookie: cookie })).status).toBe(200);
      const io = await setup();
      // same code path as the command, pointed at the database of the running application
      const store = new PasswordStore(env.t.db);
      await store.save(await hashPassword('set from the console', FAST));
      expect(io).toBeDefined();
      expect((await env.call('GET', '/api/servers', undefined, { Cookie: cookie })).status).toBe(401);
      expect((await env.call('POST', '/api/auth/login', { token: 'set from the console' })).status).toBe(200);
      expect((await env.call('GET', '/api/servers', undefined, { Authorization: `Bearer ${TOKEN}` })).status).toBe(200);
    } finally {
      await env.close();
    }
  });
});
