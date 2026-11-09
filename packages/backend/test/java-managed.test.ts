import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { temurinTarget } from '../src/java/adoptium.js';
import { MARKER_FILE } from '../src/java/managed.js';
import { javaRequirement, pickInstallMajor } from '../src/java/select.js';
import { buildTarGz, buildZip } from './archive-builders.js';
import { FakeAdoptium, managedKit, type ManagedKit } from './fake-adoptium.js';
import { scratchDir, waitFor } from './server-env.js';

let dataDir: string;
beforeEach(async () => {
  dataDir = await scratchDir('managed-');
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const win = { os: 'windows', arch: 'x64' } as const;
const entries = async (dir: string): Promise<string[]> => readdir(dir).catch(() => []);

function windowsKit(adoptium = new FakeAdoptium(), extra: Parameters<typeof managedKit>[1] = {}): ManagedKit {
  return managedKit(dataDir, { platform: 'win32', arch: 'x64', adoptium, ...extra });
}

describe('platform mapping', () => {
  it('maps node platforms and architectures to Temurin names', () => {
    expect(temurinTarget('win32', 'x64')).toMatchObject({ os: 'windows', arch: 'x64', archive: 'zip' });
    expect(temurinTarget('linux', 'arm64')).toMatchObject({ os: 'linux', arch: 'aarch64', archive: 'tar.gz' });
    expect(temurinTarget('darwin', 'arm64')).toMatchObject({ os: 'mac', arch: 'aarch64', archive: 'tar.gz' });
    expect(temurinTarget('darwin', 'x64')).toMatchObject({ os: 'mac', arch: 'x64' });
  });

  it('refuses platforms Temurin does not build for, in German', () => {
    expect(() => temurinTarget('freebsd', 'x64')).toThrowError(expect.objectContaining({ code: 'JAVA_PLATFORM_UNSUPPORTED', message: expect.stringContaining('does not offer a Java runtime') }) as Error);
    expect(() => temurinTarget('linux', 'ia32')).toThrow();
  });
});

describe('choosing the major to install', () => {
  it('uses the lowest long-term release that satisfies the server', () => {
    expect(pickInstallMajor(javaRequirement('vanilla', '1.21.1', 21))).toBe(21);
    expect(pickInstallMajor(javaRequirement('vanilla', '1.17.1', 16))).toBe(17);
    expect(pickInstallMajor(javaRequirement('vanilla', '1.20.4', 17))).toBe(17);
    expect(pickInstallMajor(javaRequirement('vanilla', '26.1', 25))).toBe(25);
    expect(pickInstallMajor(javaRequirement('vanilla', '1.8.9', null))).toBe(8);
  });

  it('respects the upper bound of legacy Forge', () => {
    expect(pickInstallMajor(javaRequirement('forge', '1.12.2', 8))).toBe(8);
    expect(pickInstallMajor(javaRequirement('forge', '1.7.10', 8))).toBe(8);
  });

  it('falls back to the exact minimum beyond the last long-term release and gives up on impossible bounds', () => {
    expect(pickInstallMajor({ min: 27, max: null, note: null })).toBe(27);
    expect(pickInstallMajor({ min: 22, max: null, note: null })).toBe(25);
    expect(pickInstallMajor({ min: 17, max: 12, note: null })).toBeNull();
  });
});

describe('installing a managed runtime (Windows branch, zip)', () => {
  it('downloads, verifies, extracts, checks java -version and renames atomically', async () => {
    const kit = windowsKit();
    kit.adoptium.add({ major: 21, ...win, image: 'jre', version: '21.0.13+9' });
    const progress: string[] = [];
    const info = await kit.managed.ensure(21, { onProgress: (p) => progress.push(p.phase) });

    expect(info.javaPath).toBe(path.join(kit.dir, 'temurin-21', 'bin', 'java.exe'));
    expect(await readFile(info.javaPath, 'utf8')).toBe('JAVA_VERSION=21.0.13');
    expect(info).toMatchObject({ major: 21, image: 'jre', release: 'jdk-21.0.13+9' });
    expect(info.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(progress).toEqual(expect.arrayContaining(['metadata', 'download', 'verify', 'extract', 'check']));
    // only the final folder remains: no staging, no partial download
    expect(await entries(kit.dir)).toEqual(['temurin-21']);
    expect(JSON.parse(await readFile(path.join(kit.dir, 'temurin-21', MARKER_FILE), 'utf8'))).toMatchObject({ major: 21, image: 'jre', javaRelPath: '.' });
  });

  it('contacts only the allowed hosts', async () => {
    const kit = windowsKit();
    kit.adoptium.add({ major: 21, ...win, image: 'jre' });
    await kit.managed.ensure(21);
    expect(kit.adoptium.hostsContacted().sort()).toEqual(['api.adoptium.net', 'github.com', 'release-assets.githubusercontent.com']);
  });

  it('prefers the JRE image and falls back to the JDK when there is none', async () => {
    const kit = windowsKit();
    kit.adoptium.add({ major: 17, ...win, image: 'jre' });
    kit.adoptium.add({ major: 17, ...win, image: 'jdk' });
    expect((await kit.managed.ensure(17)).image).toBe('jre');
    kit.adoptium.add({ major: 25, ...win, image: 'jdk' });
    expect((await kit.managed.ensure(25)).image).toBe('jdk');
  });

  it('reports a missing combination in German and leaves nothing behind', async () => {
    const kit = windowsKit(new FakeAdoptium(), { arch: 'arm64' });
    kit.adoptium.add({ major: 21, os: 'windows', arch: 'aarch64', image: 'jre' });
    await expect(kit.managed.ensure(8)).rejects.toMatchObject({
      code: 'JAVA_NOT_AVAILABLE',
      message: expect.stringContaining('Eclipse Temurin does not offer Java 8 for Windows (arm64)'),
    });
    expect(await entries(kit.dir)).toEqual([]);
    await expect(kit.managed.ensure(21)).resolves.toMatchObject({ major: 21 });
  });

  it('rejects a download whose checksum differs and cleans up', async () => {
    const kit = windowsKit();
    kit.adoptium.add({ major: 21, ...win, image: 'jre' });
    kit.adoptium.tamper = true;
    await expect(kit.managed.ensure(21)).rejects.toMatchObject({ code: 'DOWNLOAD_HASH_MISMATCH' });
    expect(await entries(kit.dir)).toEqual([]);
    expect(await kit.managed.read(21)).toBeNull();
  });

  it('rejects a runtime that reports a different Java version', async () => {
    const kit = windowsKit();
    kit.adoptium.add({ major: 21, ...win, image: 'jre', reportsMajor: 17 });
    await expect(kit.managed.ensure(21)).rejects.toMatchObject({ code: 'JAVA_INSTALL_INVALID', message: expect.stringContaining('version 17 instead of 21') });
    expect(await entries(kit.dir)).toEqual([]);
  });

  it('rejects an archive without a java executable', async () => {
    const kit = windowsKit(undefined, { probe: async () => null });
    kit.adoptium.add({ major: 21, ...win, image: 'jre' });
    await expect(kit.managed.ensure(21)).rejects.toMatchObject({ code: 'JAVA_INSTALL_INVALID' });
    expect(await entries(kit.dir)).toEqual([]);
  });

  it('refuses a redirect to a host that is not allowed', async () => {
    const kit = windowsKit();
    kit.adoptium.add({ major: 21, ...win, image: 'jre' });
    kit.adoptium.redirectHost = 'evil.example.com';
    await expect(kit.managed.ensure(21)).rejects.toMatchObject({ code: 'DOWNLOAD_URL_REJECTED' });
    expect(kit.adoptium.hostsContacted()).not.toContain('evil.example.com');
    expect(await entries(kit.dir)).toEqual([]);
  });

  it('reports an unreachable API and an API error', async () => {
    const kit = windowsKit();
    kit.adoptium.failApi = true;
    await expect(kit.managed.ensure(21)).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
    const broken = windowsKit(undefined, { fetch: async () => { throw new TypeError('offline'); } });
    await expect(broken.managed.ensure(21)).rejects.toMatchObject({ code: 'UPSTREAM_UNREACHABLE', message: expect.stringContaining('api.adoptium.net') });
  });

  it('checks free disk space first', async () => {
    const kit = windowsKit(undefined, { freeSpace: async () => 1024 });
    kit.adoptium.add({ major: 21, ...win, image: 'jre' });
    await expect(kit.managed.ensure(21)).rejects.toMatchObject({ code: 'DISK_FULL', message: expect.stringContaining('Java 21') });
    expect(kit.adoptium.requests.some((request) => request.includes('release-assets'))).toBe(false);
  });

  it('is idempotent: a second call finds the installed runtime without downloading', async () => {
    const kit = windowsKit();
    kit.adoptium.add({ major: 21, ...win, image: 'jre' });
    await kit.managed.ensure(21);
    const before = kit.adoptium.requests.length;
    await kit.managed.ensure(21);
    expect(kit.adoptium.requests).toHaveLength(before);
  });
});

describe('one install per major', () => {
  it('lets concurrent callers share a single download and its progress', async () => {
    const kit = windowsKit();
    kit.adoptium.add({ major: 21, ...win, image: 'jre' });
    kit.adoptium.downloadDelayMs = 80;
    const first: string[] = [];
    const second: string[] = [];
    const results = await Promise.all([
      kit.managed.ensure(21, { onProgress: (p) => first.push(p.phase) }),
      kit.managed.ensure(21, { onProgress: (p) => second.push(p.phase) }),
      kit.managed.ensure(21),
    ]);
    expect(new Set(results.map((r) => r.javaPath)).size).toBe(1);
    expect(kit.adoptium.requests.filter((request) => request.includes('release-assets'))).toHaveLength(1);
    expect(kit.adoptium.requests.filter((request) => request.includes('api.adoptium.net'))).toHaveLength(1);
    expect(second.length).toBeGreaterThan(0);
    expect(first).toContain('download');
  });

  it('installs different majors independently', async () => {
    const kit = windowsKit();
    kit.adoptium.add({ major: 21, ...win, image: 'jre' });
    kit.adoptium.add({ major: 17, ...win, image: 'jre' });
    await Promise.all([kit.managed.ensure(21), kit.managed.ensure(17)]);
    expect((await kit.managed.list()).map((info) => info.major)).toEqual([17, 21]);
  });

  it('keeps the job running while another caller waits and aborts it when the last one leaves', async () => {
    const kit = windowsKit();
    kit.adoptium.add({ major: 21, ...win, image: 'jre' });
    kit.adoptium.hang = true;
    const a = new AbortController();
    const b = new AbortController();
    const first = kit.managed.ensure(21, { signal: a.signal });
    const second = kit.managed.ensure(21, { signal: b.signal });
    const firstResult = first.catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 50));
    a.abort();
    expect(await firstResult).toMatchObject({ code: 'JAVA_INSTALL_ABORTED' });
    expect(kit.managed.isInstalling(21)).toBe(true);
    const secondResult = second.catch((error: unknown) => error);
    b.abort();
    expect(await secondResult).toMatchObject({ code: 'JAVA_INSTALL_ABORTED' });
    await waitFor(async () => !kit.managed.isInstalling(21) && (await entries(kit.dir)).length === 0, 20_000, 'cancellation and cleanup');
    expect(kit.managed.isInstalling(21)).toBe(false);
    expect(await entries(kit.dir)).toEqual([]);
  });

  it('aborts running installs on shutdown without leaving staging folders', async () => {
    const kit = windowsKit();
    kit.adoptium.add({ major: 21, ...win, image: 'jre' });
    kit.adoptium.hang = true;
    const pending = kit.managed.ensure(21).catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 50));
    kit.managed.shutdown();
    expect(await pending).toMatchObject({ code: 'JAVA_INSTALL_ABORTED' });
    await waitFor(async () => (await entries(kit.dir)).length === 0, 20_000, 'cleanup');
    expect(await entries(kit.dir)).toEqual([]);
  });

  it('emits running, done and failed events', async () => {
    const kit = windowsKit();
    kit.adoptium.add({ major: 21, ...win, image: 'jre' });
    const states: string[] = [];
    kit.managed.onEvent((event) => states.push(`${event.major}:${event.state}`));
    await kit.managed.ensure(21);
    await kit.managed.ensure(17).catch(() => undefined);
    expect(states).toContain('21:running');
    expect(states).toContain('21:done');
    expect(states).toContain('17:failed');
  });
});

describe('boot cleanup and removal', () => {
  it('deletes staging folders and runtimes without a valid marker, keeps good ones', async () => {
    const kit = windowsKit();
    kit.adoptium.add({ major: 21, ...win, image: 'jre' });
    await kit.managed.ensure(21);
    await mkdir(path.join(kit.dir, '.tmp-17-abc', 'extract'), { recursive: true });
    await writeFile(path.join(kit.dir, '.tmp-17-abc', 'x.part'), 'half');
    await mkdir(path.join(kit.dir, '.removing-8-zzz'), { recursive: true });
    await mkdir(path.join(kit.dir, 'temurin-25', 'bin'), { recursive: true });
    await writeFile(path.join(kit.dir, 'temurin-25', 'bin', 'java.exe'), 'JAVA_VERSION=25.0.1');
    expect(await kit.managed.cleanup()).toBe(3);
    expect((await entries(kit.dir)).sort()).toEqual(['temurin-21']);
    expect(await kit.managed.read(21)).not.toBeNull();
  });

  it('never lists a folder without a marker as usable', async () => {
    const kit = windowsKit();
    await mkdir(path.join(kit.dir, 'temurin-21', 'bin'), { recursive: true });
    await writeFile(path.join(kit.dir, 'temurin-21', 'bin', 'java.exe'), 'JAVA_VERSION=21.0.1');
    expect(await kit.managed.list()).toEqual([]);
    expect(await kit.java.detect(true)).toEqual([]);
  });

  it('removes a runtime and refuses unknown ones', async () => {
    const kit = windowsKit();
    kit.adoptium.add({ major: 21, ...win, image: 'jre' });
    await kit.managed.ensure(21);
    await kit.managed.remove(21);
    expect(await entries(kit.dir)).toEqual([]);
    await expect(kit.managed.remove(21)).rejects.toMatchObject({ code: 'JAVA_RUNTIME_NOT_FOUND' });
  });

  it('refuses to remove a runtime while it is being installed', async () => {
    const kit = windowsKit();
    kit.adoptium.add({ major: 21, ...win, image: 'jre' });
    kit.adoptium.hang = true;
    const pending = kit.managed.ensure(21).catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await expect(kit.managed.remove(21)).rejects.toMatchObject({ code: 'JAVA_INSTALL_RUNNING' });
    kit.managed.shutdown();
    await pending;
  });
});

describe('detection and selection with managed runtimes', () => {
  it('includes managed runtimes with their origin and selects them', async () => {
    const kit = windowsKit();
    kit.adoptium.add({ major: 21, ...win, image: 'jre', version: '21.0.13+9' });
    await kit.managed.ensure(21);
    const runtimes = await kit.java.detect(true);
    expect(runtimes).toHaveLength(1);
    expect(runtimes[0]).toMatchObject({ major: 21, source: 'managed' });
    expect(runtimes[0]?.origin).toContain('Eclipse Temurin 21.0.13+9-LTS (JRE)');
    expect(runtimes[0]?.origin).toContain('api.adoptium.net');
    expect(runtimes[0]?.origin).toContain('SHA-256');
    const selection = await kit.java.select({ javaPath: null, loader: 'vanilla', mcVersion: '1.21.1', requiredMajor: 21 });
    expect(selection.runtime.source).toBe('managed');
  });

  it('plans an installation only when automatic installation is on and no runtime fits', async () => {
    const on = windowsKit();
    expect(await on.java.plan({ javaPath: null, loader: 'vanilla', mcVersion: '1.21.1', requiredMajor: 21 })).toMatchObject({ kind: 'install', major: 21 });
    expect(await on.java.plan({ javaPath: null, loader: 'forge', mcVersion: '1.12.2', requiredMajor: 8 })).toMatchObject({ kind: 'install', major: 8 });

    const off = windowsKit(undefined, { autoInstall: false });
    await expect(off.java.plan({ javaPath: null, loader: 'vanilla', mcVersion: '1.21.1', requiredMajor: 21 })).rejects.toMatchObject({ code: 'JAVA_NOT_FOUND' });
  });

  it('keeps JAVA_VERSION_INCOMPATIBLE when installing is off and only a wrong version exists', async () => {
    const kit = windowsKit(undefined, { autoInstall: false });
    kit.adoptium.add({ major: 17, ...win, image: 'jre' });
    await kit.managed.ensure(17);
    await expect(kit.java.plan({ javaPath: null, loader: 'vanilla', mcVersion: '1.21.1', requiredMajor: 21 })).rejects.toMatchObject({ code: 'JAVA_VERSION_INCOMPATIBLE' });
  });

  it('does not install when the server pins its own Java path', async () => {
    const kit = windowsKit();
    await expect(kit.java.plan({ javaPath: path.join(dataDir, 'missing', 'java.exe'), loader: 'vanilla', mcVersion: '1.21.1', requiredMajor: 21 })).rejects.toMatchObject({
      code: 'JAVA_NOT_FOUND',
    });
  });

  it('acquire installs the missing runtime and then selects it', async () => {
    const kit = windowsKit();
    kit.adoptium.add({ major: 21, ...win, image: 'jre' });
    const selection = await kit.java.acquire({ javaPath: null, loader: 'vanilla', mcVersion: '1.21.1', requiredMajor: 21 });
    expect(selection.runtime).toMatchObject({ major: 21, source: 'managed' });
  });

  it('removing a managed runtime refreshes the detection', async () => {
    const kit = windowsKit();
    kit.adoptium.add({ major: 21, ...win, image: 'jre' });
    await kit.java.ensureManaged(21);
    expect(await kit.java.detect()).toHaveLength(1);
    await kit.java.removeManaged(21);
    expect(await kit.java.detect()).toHaveLength(0);
  });
});

describe('Linux and macOS branches (tar.gz)', () => {
  it('installs a linux x64 runtime (with an in-archive symlink where the host can create one)', async () => {
    const adoptium = new FakeAdoptium();
    adoptium.add({ major: 21, os: 'linux', arch: 'x64', image: 'jre' });
    const kit = managedKit(dataDir, { platform: 'linux', arch: 'x64', adoptium });
    const info = await kit.managed.ensure(21);
    expect(info.javaPath).toBe(path.join(kit.dir, 'temurin-21', 'bin', 'java'));
    if (process.platform !== 'win32') expect((await stat(info.javaPath)).mode & 0o100).toBeTruthy();
    expect(adoptium.requests.some((request) => request.includes('architecture=x64') && request.includes('os=linux'))).toBe(true);
    expect(await kit.java.detect(true)).toHaveLength(1);
  });

  it('asks for aarch64 on arm64 and for mac on darwin, and finds the java below Contents/Home', async () => {
    const adoptium = new FakeAdoptium();
    adoptium.add({ major: 17, os: 'mac', arch: 'aarch64', image: 'jre' });
    const kit = managedKit(dataDir, { platform: 'darwin', arch: 'arm64', adoptium });
    const info = await kit.managed.ensure(17);
    expect(info.javaPath).toContain(path.join('Contents', 'Home', 'bin', 'java'));
    expect(adoptium.requests.some((request) => request.includes('architecture=aarch64') && request.includes('os=mac'))).toBe(true);
    expect(JSON.parse(await readFile(path.join(kit.dir, 'temurin-17', MARKER_FILE), 'utf8')).javaRelPath).toBe('Contents/Home');
  });

  it('refuses a tar.gz whose symlink points out of the runtime folder', async () => {
    const adoptium = new FakeAdoptium();
    adoptium.add({
      major: 21,
      os: 'linux',
      arch: 'x64',
      image: 'jre',
      archive: buildTarGz([{ name: 'jdk/', type: '5' }, { name: 'jdk/escape', type: '2', linkname: '../../../outside' }]),
    });
    const kit = managedKit(dataDir, { platform: 'linux', arch: 'x64', adoptium });
    await expect(kit.managed.ensure(21)).rejects.toMatchObject({ code: 'ARCHIVE_UNSAFE' });
    expect(await entries(kit.dir)).toEqual([]);
  });

  it('refuses a zip with a path that climbs out of the extraction folder and writes nothing outside', async () => {
    const adoptium = new FakeAdoptium();
    adoptium.add({
      major: 21,
      os: 'windows',
      arch: 'x64',
      image: 'jre',
      archive: buildZip([{ name: 'jdk/bin/java.exe', content: 'JAVA_VERSION=21.0.1' }, { name: '../../evil.txt', content: 'evil' }]),
    });
    const kit = managedKit(dataDir, { platform: 'win32', arch: 'x64', adoptium });
    await expect(kit.managed.ensure(21)).rejects.toMatchObject({ code: 'ARCHIVE_UNSAFE' });
    expect(await entries(kit.dir)).toEqual([]);
    expect(await entries(dataDir)).not.toContain('evil.txt');
  });
});
