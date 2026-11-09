import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../src/http/errors.js';
import { detectInstallMode, NOTE_DEV, NOTE_PORTABLE, readTestMarker } from '../src/update/environment.js';
import { assertUpdateUrl, downloadFile, fetchUpdate, UPDATE_ALLOWED_HOSTS, type UpdateHttpOptions } from '../src/update/http.js';
import { TRUSTED_UPDATE_KEYS } from '../src/update/keys.js';
import { ASSET_NAME_PATTERN, clearRequestDir, newRequest, readStatus, requestSchema, statusSchema, submitRequest } from '../src/update/protocol.js';
import { findFiles, isExpectedAssetUrl, parseReleases, pickLatest, platformAssetName } from '../src/update/releases.js';
import { compareSemver, isNewerVersion, normalizeVersion, parseSemver } from '../src/update/semver.js';
import { canTransition, IllegalTransition, isBlockingPhase, isBusy, nextPhase } from '../src/update/state.js';
import { decodeSignature, parseSha256Sums, sha256File, verifyRelease, verifySumsSignature } from '../src/update/verify.js';
import { buildRelease, FakeGithub, makeKeys, sha256 } from './fake-github.js';
import cases from '../../../scripts/test/semver-cases.json' with { type: 'json' };

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'cm-update-unit-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('semver', () => {
  it.each(cases as Array<[string, string, number]>)('compares %s with %s -> %i', (a, b, expected) => {
    expect(compareSemver(parseSemver(a)!, parseSemver(b)!)).toBe(expected);
    expect(compareSemver(parseSemver(b)!, parseSemver(a)!)).toBe(expected === 0 ? 0 : -expected);
  });

  it('only a strictly greater version is newer', () => {
    expect(isNewerVersion('0.1.1', '0.1.0')).toBe(true);
    expect(isNewerVersion('0.1.0', '0.1.0')).toBe(false);
    expect(isNewerVersion('0.0.9', '0.1.0')).toBe(false);
    expect(isNewerVersion('0.1.0-rc.1', '0.1.0')).toBe(false);
    expect(isNewerVersion('garbage', '0.1.0')).toBe(false);
    expect(isNewerVersion('0.1.1', 'garbage')).toBe(false);
  });

  it('rejects things that are not versions and normalizes tags', () => {
    for (const bad of ['', '1', '1.2', '01.2.3', '1.2.3.4', 'v', '1.2.3-', '1.2.3-a..b', 'latest', '1.2.99999999999999999999']) expect(parseSemver(bad)).toBeNull();
    expect(normalizeVersion('v1.2.3')).toBe('1.2.3');
    expect(normalizeVersion('1.2.3-rc.1+build')).toBe('1.2.3-rc.1');
    expect(normalizeVersion('nope')).toBeNull();
  });
});

describe('signature and hash verification', () => {
  const keys = makeKeys();
  const trusted = [{ id: 'test', publicKey: keys.publicPem }];

  function input(overrides: Parameters<typeof buildRelease>[0] extends infer T ? Partial<T> : never = {}) {
    const release = buildRelease({ version: '0.2.0', keys, ...overrides });
    const sums = release.files.get('SHA256SUMS.txt')!;
    const asset = release.files.get(release.assetName)!;
    return { release, args: { sums, signature: release.files.get('SHA256SUMS.txt.sig')?.toString() ?? '', keys: trusted, assetName: release.assetName, assetSha256: sha256(asset) } };
  }

  it('accepts a correctly signed release', () => {
    expect(() => verifyRelease(input().args)).not.toThrow();
  });

  it('rejects a signature made with another key', () => {
    const { args } = input({ signWith: makeKeys() });
    expect(() => verifyRelease(args)).toThrowError(expect.objectContaining({ code: 'UPDATE_SIGNATURE_INVALID' }));
  });

  it('rejects tampered sums even if the hash line would fit the asset', () => {
    const { args } = input({ tamperSums: true });
    expect(() => verifyRelease(args)).toThrowError(expect.objectContaining({ code: 'UPDATE_SIGNATURE_INVALID' }));
  });

  it('rejects a tampered asset', () => {
    const release = buildRelease({ version: '0.2.0', keys, tamperAsset: true });
    const args = {
      sums: release.files.get('SHA256SUMS.txt')!,
      signature: release.files.get('SHA256SUMS.txt.sig')!.toString(),
      keys: trusted,
      assetName: release.assetName,
      assetSha256: sha256(release.files.get(release.assetName)!),
    };
    expect(() => verifyRelease(args)).toThrowError(expect.objectContaining({ code: 'UPDATE_HASH_MISMATCH' }));
  });

  it('rejects an asset the signed sums do not list', () => {
    const { args } = input();
    expect(() => verifyRelease({ ...args, assetName: 'worldfoundry-9.9.9-linux-x64.tar.gz' })).toThrowError(expect.objectContaining({ code: 'UPDATE_SUMS_INVALID' }));
  });

  it('rejects missing, malformed or wrong-length signatures and an empty key list', () => {
    const { args } = input();
    expect(verifySumsSignature(args.sums, '', trusted)).toBe(false);
    expect(verifySumsSignature(args.sums, 'abc', trusted)).toBe(false);
    expect(verifySumsSignature(args.sums, Buffer.alloc(63).toString('base64'), trusted)).toBe(false);
    expect(verifySumsSignature(args.sums, args.signature, [])).toBe(false);
    expect(verifySumsSignature(args.sums, args.signature, [{ id: 'broken', publicKey: 'not a pem' }])).toBe(false);
    expect(decodeSignature(`${args.signature}\n`)).not.toBeNull();
  });

  it('accepts any of several trusted keys (rotation)', () => {
    const other = makeKeys();
    const { args } = input();
    expect(verifySumsSignature(args.sums, args.signature, [{ id: 'old', publicKey: other.publicPem }, ...trusted])).toBe(true);
  });

  it('parses sums files with CRLF and binary markers and refuses contradictions', () => {
    const map = parseSha256Sums(`${'a'.repeat(64)}  one.zip\r\n${'B'.repeat(64)} *two.zip\r\n\r\n`);
    expect(map.get('one.zip')).toBe('a'.repeat(64));
    expect(map.get('two.zip')).toBe('b'.repeat(64));
    expect(() => parseSha256Sums('not valid')).toThrow(AppError);
    expect(() => parseSha256Sums(`${'a'.repeat(64)}  x\n${'b'.repeat(64)}  x\n`)).toThrow(AppError);
  });

  it('hashes files', async () => {
    await writeFile(path.join(dir, 'f'), 'hello');
    expect(await sha256File(path.join(dir, 'f'))).toBe(sha256('hello'));
  });

  it('ships a usable production key', () => {
    expect(TRUSTED_UPDATE_KEYS.length).toBeGreaterThan(0);
    for (const key of TRUSTED_UPDATE_KEYS) expect(key.publicKey).toContain('BEGIN PUBLIC KEY');
  });
});

describe('host allowlist and redirects', () => {
  const base = (github: FakeGithub, extra: Partial<UpdateHttpOptions> = {}): UpdateHttpOptions => ({
    fetch: github.fetch as typeof fetch,
    allowedHosts: UPDATE_ALLOWED_HOSTS,
    timeoutMs: 2000,
    userAgent: 'WorldFoundry/0.1.0',
    ...extra,
  });

  it('allows exactly the GitHub hosts', () => {
    for (const host of UPDATE_ALLOWED_HOSTS) expect(() => assertUpdateUrl(`https://${host}/x`, { allowedHosts: UPDATE_ALLOWED_HOSTS })).not.toThrow();
    for (const bad of ['https://evil.example/x', 'https://github.com.evil.example/x', 'https://api.github.com:8443/x', 'http://api.github.com/x', 'https://user:pw@github.com/x', 'ftp://github.com/x', 'not-a-url']) {
      expect(() => assertUpdateUrl(bad, { allowedHosts: UPDATE_ALLOWED_HOSTS }), bad).toThrowError(expect.objectContaining({ code: 'UPDATE_URL_REJECTED' }));
    }
  });

  it('follows the real redirect chain github.com -> release-assets.githubusercontent.com and checks every hop', async () => {
    const github = new FakeGithub();
    const keys = makeKeys();
    github.add(buildRelease({ version: '0.2.0', keys }));
    const response = await fetchUpdate('https://github.com/owner/repo/releases/download/v0.2.0/SHA256SUMS.txt', base(github));
    expect(response.status).toBe(200);
    expect(github.hosts).toEqual(['github.com', 'release-assets.githubusercontent.com']);
    // identifies itself, without any personal data and without credentials
    const headers = github.requests[0]!.headers;
    expect(headers['user-agent']).toBe('WorldFoundry/0.1.0');
    expect(JSON.stringify(headers)).not.toMatch(/@|authorization/i);
  });

  it('refuses a redirect to a host outside the allowlist before contacting it', async () => {
    const github = new FakeGithub();
    github.add(buildRelease({ version: '0.2.0', keys: makeKeys() }));
    github.redirectHost = 'evil.example';
    await expect(fetchUpdate('https://github.com/owner/repo/releases/download/v0.2.0/SHA256SUMS.txt', base(github))).rejects.toMatchObject({ code: 'UPDATE_URL_REJECTED' });
    expect(github.hosts).toEqual(['github.com']);
  });

  it('stops redirect loops and applies the size limit while downloading', async () => {
    const loop: typeof fetch = async () => new Response(null, { status: 302, headers: { location: 'https://github.com/again' } });
    await expect(fetchUpdate('https://github.com/x', { fetch: loop, allowedHosts: UPDATE_ALLOWED_HOSTS, timeoutMs: 1000, userAgent: 'a' })).rejects.toMatchObject({ code: 'UPDATE_DOWNLOAD_FAILED' });

    const github = new FakeGithub();
    github.add(buildRelease({ version: '0.2.0', keys: makeKeys(), assetBytes: Buffer.alloc(5000, 1) }));
    const url = 'https://github.com/owner/repo/releases/download/v0.2.0/worldfoundry-0.2.0-linux-x64.tar.gz';
    await expect(downloadFile(url, path.join(dir, 'a.bin'), { ...base(github), maxBytes: 1000 })).rejects.toMatchObject({ code: 'UPDATE_TOO_LARGE' });
    expect(await readdir(dir)).toEqual([]);
    await expect(downloadFile(url, path.join(dir, 'a.bin'), { ...base(github), maxBytes: 10_000, expectedSize: 4999 })).rejects.toMatchObject({ code: 'UPDATE_SIZE_MISMATCH' });
    expect(await readdir(dir)).toEqual([]);
    const ok = await downloadFile(url, path.join(dir, 'a.bin'), { ...base(github), maxBytes: 10_000, expectedSize: 5000 });
    expect(ok).toEqual({ size: 5000, sha256: sha256(Buffer.alloc(5000, 1)) });
  });

  it('only a test build may use plain http', () => {
    const options = { allowedHosts: [...UPDATE_ALLOWED_HOSTS, '127.0.0.1'] };
    expect(() => assertUpdateUrl('http://127.0.0.1:4599/x', options)).toThrow();
    expect(assertUpdateUrl('http://127.0.0.1:4599/x', { ...options, allowInsecureHttp: true }).port).toBe('4599');
    expect(() => assertUpdateUrl('http://evil.example/x', { ...options, allowInsecureHttp: true })).toThrow();
  });
});

describe('release metadata', () => {
  const keys = makeKeys();
  const list = (...releases: Array<ReturnType<typeof buildRelease>>) => parseReleases(releases.map((release) => release.json), 'owner/repo', { allowInsecureHttp: false });

  it('picks the newest stable release and ignores drafts and prereleases unless the channel allows them', () => {
    const releases = list(
      buildRelease({ version: '0.2.0', keys }),
      buildRelease({ version: '0.3.0', keys, draft: true }),
      buildRelease({ version: '0.4.0-rc.1', keys, prerelease: true }),
      buildRelease({ version: '0.1.5', keys }),
    );
    expect(releases.map((release) => release.version)).toEqual(['0.2.0', '0.4.0-rc.1', '0.1.5']);
    expect(pickLatest(releases, 'stable')?.version).toBe('0.2.0');
    expect(pickLatest(releases, 'prerelease')?.version).toBe('0.4.0-rc.1');
    expect(pickLatest([], 'stable')).toBeNull();
  });

  it('treats a -rc version as prerelease even when GitHub does not flag it', () => {
    const release = buildRelease({ version: '0.5.0-rc.2', keys });
    expect(list(release)[0]?.prerelease).toBe(true);
  });

  it('only accepts download addresses of this repository', () => {
    expect(isExpectedAssetUrl('https://github.com/owner/repo/releases/download/v1.0.0/a.zip', 'owner/repo', 'v1.0.0', 'a.zip', false)).toBe(true);
    expect(isExpectedAssetUrl('https://github.com/Owner/Repo/releases/download/v1.0.0/a.zip', 'owner/repo', 'v1.0.0', 'a.zip', false)).toBe(true);
    expect(isExpectedAssetUrl('https://github.com/other/repo/releases/download/v1.0.0/a.zip', 'owner/repo', 'v1.0.0', 'a.zip', false)).toBe(false);
    expect(isExpectedAssetUrl('https://evil.example/owner/repo/releases/download/v1.0.0/a.zip', 'owner/repo', 'v1.0.0', 'a.zip', false)).toBe(false);
    expect(isExpectedAssetUrl('http://github.com/owner/repo/releases/download/v1.0.0/a.zip', 'owner/repo', 'v1.0.0', 'a.zip', false)).toBe(false);
    expect(isExpectedAssetUrl('http://127.0.0.1:1/x', 'owner/repo', 'v1.0.0', 'a.zip', true)).toBe(true);
  });

  it('finds the asset of the own platform plus the signed sums', () => {
    const release = list(buildRelease({ version: '0.2.0', keys }))[0]!;
    const found = findFiles(release, 'linux', 'x64');
    expect(found.ok && found.files.asset.name).toBe('worldfoundry-0.2.0-linux-x64.tar.gz');
    expect(findFiles(release, 'linux', 'arm64')).toMatchObject({ ok: false });
    expect(findFiles(release, 'darwin', 'arm64')).toMatchObject({ ok: false });
    const unsigned = list(buildRelease({ version: '0.2.0', keys, withoutSignature: true }))[0]!;
    expect(findFiles(unsigned, 'linux', 'x64')).toMatchObject({ ok: false, reason: expect.stringContaining('signed') });
    expect(platformAssetName('1.0.0', 'win32', 'x64')).toBe('worldfoundry-1.0.0-setup.exe');
    expect(platformAssetName('1.0.0', 'win32', 'arm64')).toBeNull();
  });

  it('shows notes as plain text without control characters and with a size limit', () => {
    const release = buildRelease({ version: '0.2.0', keys, notes: `<script>alert(1)</script>\u0000\u0007 ok\r\n${'x'.repeat(30_000)}` });
    const notes = list(release)[0]!.notes;
    expect(notes).toContain('<script>alert(1)</script>');
    expect(notes).not.toMatch(/[\u0000\u0007\r]/);
    expect(notes.length).toBeLessThanOrEqual(20_000);
  });
});

describe('update state machine', () => {
  it('walks through the whole run', () => {
    let phase = nextPhase('idle', 'start');
    for (const [event, expected] of [
      ['downloaded', 'verifying'],
      ['verified', 'waiting-for-servers'],
      ['servers-stopped', 'installing'],
      ['restarting', 'restarting'],
      ['succeeded', 'done'],
      ['dismiss', 'idle'],
    ] as const) {
      phase = nextPhase(phase, event);
      expect(phase).toBe(expected);
    }
  });

  it('refuses moves that would skip a step', () => {
    expect(() => nextPhase('idle', 'verified')).toThrow(IllegalTransition);
    expect(() => nextPhase('downloading', 'servers-stopped')).toThrow(IllegalTransition);
    expect(() => nextPhase('installing', 'cancelled')).toThrow(IllegalTransition);
    expect(canTransition('waiting-for-servers', 'cancelled')).toBe(true);
    expect(canTransition('failed', 'start')).toBe(true);
    expect(canTransition('installing', 'start')).toBe(false);
  });

  it('knows which phases are busy and which block server changes', () => {
    expect(isBusy('idle')).toBe(false);
    expect(isBusy('done')).toBe(false);
    expect(isBusy('failed')).toBe(false);
    expect(isBusy('downloading')).toBe(true);
    expect(isBlockingPhase('downloading')).toBe(false);
    for (const phase of ['waiting-for-servers', 'installing', 'restarting'] as const) expect(isBlockingPhase(phase)).toBe(true);
  });
});

describe('request/status protocol', () => {
  it('validates requests: only known asset names and a bounded shape', () => {
    const ok = newRequest('0.2.0', '0.1.0', 'worldfoundry-0.2.0-linux-x64.tar.gz', 1);
    expect(requestSchema.safeParse(ok).success).toBe(true);
    for (const name of ['../evil.tar.gz', 'worldfoundry-0.2.0-linux-x64.tar.gz/../x', 'worldfoundry-0.2.0.zip', 'x.exe', 'worldfoundry-1-setup.exe\\..\\a']) {
      expect(ASSET_NAME_PATTERN.test(name), name).toBe(false);
    }
    expect(ASSET_NAME_PATTERN.test('worldfoundry-0.2.0-setup.exe')).toBe(true);
    expect(requestSchema.safeParse({ ...ok, assetName: '../../etc/passwd' }).success).toBe(false);
    expect(requestSchema.safeParse({ ...ok, schema: 2 }).success).toBe(false);
  });

  it('writes request.json last and replaces earlier leftovers', async () => {
    const request = newRequest('0.2.0', '0.1.0', 'worldfoundry-0.2.0-linux-x64.tar.gz', 1);
    const staged = path.join(dir, 'staged');
    await mkdir(staged);
    for (const name of [request.assetName, 'SHA256SUMS.txt', 'SHA256SUMS.txt.sig']) await writeFile(path.join(staged, name), name);
    const requestDir = path.join(dir, 'request');
    await mkdir(requestDir);
    await writeFile(path.join(requestDir, 'worldfoundry-0.0.1-setup.exe'), 'old');
    await writeFile(path.join(requestDir, 'foreign.txt'), 'stays');
    await submitRequest(requestDir, request, { asset: path.join(staged, request.assetName), sums: path.join(staged, 'SHA256SUMS.txt'), signature: path.join(staged, 'SHA256SUMS.txt.sig') });
    expect((await readdir(requestDir)).sort()).toEqual(['SHA256SUMS.txt', 'SHA256SUMS.txt.sig', 'foreign.txt', 'request.json', 'worldfoundry-0.2.0-linux-x64.tar.gz']);
    expect(requestSchema.parse(JSON.parse(await readFile(path.join(requestDir, 'request.json'), 'utf8')))).toEqual(request);
    await clearRequestDir(requestDir);
    expect(await readdir(requestDir)).toEqual(['foreign.txt']);
  });

  it('reads the status of the updater and ignores garbage or symlink tricks', async () => {
    expect(await readStatus(dir)).toBeNull();
    await writeFile(path.join(dir, 'status.json'), 'not json');
    expect(await readStatus(dir)).toBeNull();
    const good = { schema: 1, id: 'abc12345', state: 'rolled-back', version: '0.2.0', from: '0.1.0', message: 'back', updatedAt: 5 };
    expect(statusSchema.safeParse(good).success).toBe(true);
    await writeFile(path.join(dir, 'status.json'), JSON.stringify(good));
    expect(await readStatus(dir)).toEqual(good);
    await writeFile(path.join(dir, 'status.json'), JSON.stringify({ ...good, state: 'hacked' }));
    expect(await readStatus(dir)).toBeNull();
  });
});

describe('install mode', () => {
  it('detects dev (checkout), service (updater folder with request/) and portable', async () => {
    const repo = path.resolve(import.meta.dirname, '..');
    expect(detectInstallMode({}, repo, 'linux')).toEqual({ mode: 'dev', note: NOTE_DEV });

    const code = path.join(dir, 'app', 'backend');
    await mkdir(code, { recursive: true });
    expect(detectInstallMode({}, code, 'linux')).toEqual({ mode: 'portable', note: NOTE_PORTABLE });
    const updateDir = path.join(dir, 'upd');
    expect(detectInstallMode({ updateDir }, code, 'linux').mode).toBe('portable');
    await mkdir(path.join(updateDir, 'request'), { recursive: true });
    expect(detectInstallMode({ updateDir }, code, 'linux')).toEqual({ mode: 'service', note: null });
    expect(detectInstallMode({ updateDir }, code, 'darwin').mode).toBe('portable');
  });

  it('reads the test marker only from a valid file in the install folder', async () => {
    expect(readTestMarker(dir)).toBeNull();
    await mkdir(path.join(dir, 'tools'));
    await writeFile(path.join(dir, 'tools', 'update-test.json'), 'broken');
    expect(readTestMarker(dir)).toBeNull();
    const pem = makeKeys().publicPem;
    await writeFile(path.join(dir, 'tools', 'update-test.json'), JSON.stringify({ apiBase: 'http://127.0.0.1:4599', trustedKeys: [{ id: 'ci', publicKey: pem }] }));
    expect(readTestMarker(dir)).toEqual({ apiBase: 'http://127.0.0.1:4599', trustedKeys: [{ id: 'ci', publicKey: pem }] });
  });

  it('does not follow a symlinked request file when submitting (the updater side is covered in scripts/test)', async () => {
    const requestDir = path.join(dir, 'request');
    await mkdir(requestDir);
    const target = path.join(dir, 'target.txt');
    await writeFile(target, 'untouched');
    try {
      await symlink(target, path.join(requestDir, 'SHA256SUMS.txt'));
    } catch {
      return; // no symlink permission on this machine
    }
    await clearRequestDir(requestDir);
    expect(await readFile(target, 'utf8')).toBe('untouched');
  });
});
