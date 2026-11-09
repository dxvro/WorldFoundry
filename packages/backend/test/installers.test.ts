import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../src/http/errors.js';
import { INSTALLER_DOWNLOAD_HOSTS, LoaderCatalog } from '../src/installer/catalog.js';
import { detectForgeLaunch } from '../src/installer/detect-launch.js';
import { compareMcDesc, isYearBased, mcAtMost, parseMcVersion } from '../src/installer/mc-version.js';
import { neoForgeMcVersion } from '../src/installer/providers.js';
import type { ResolvedInstall } from '../src/installer/types.js';
import { downloadToTmp } from '../src/mods/downloader.js';
import { FakeUpstream, zipBytes } from './fake-upstream.js';
import { scratchDir } from './server-env.js';

let upstream: FakeUpstream;
let catalog: LoaderCatalog;
let now = 0;
beforeEach(() => {
  upstream = new FakeUpstream();
  now = 1_000_000;
  catalog = new LoaderCatalog({ fetch: upstream.fetch, userAgent: 'test-agent/1.0', timeoutMs: 500, cacheTtlMs: 5 * 60_000, now: () => now });
});

const failure = async (promise: Promise<unknown>): Promise<AppError> => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error('expected a failure');
};

const sha = (algorithm: string, data: Buffer): string => createHash(algorithm).update(data).digest('hex');

describe('version helpers', () => {
  it('orders and classifies Minecraft versions, including year-based ones', () => {
    expect(['1.9', '1.21.1', '26.1', '1.21', '26.1.2', '1.20.4'].sort(compareMcDesc)).toEqual(['26.1.2', '26.1', '1.21.1', '1.21', '1.20.4', '1.9']);
    expect(parseMcVersion('26.4-snapshot-7')).toEqual([26, 4]);
    expect(parseMcVersion('b1.7.3')).toBeNull();
    expect(isYearBased('26.1')).toBe(true);
    expect(isYearBased('1.21.11')).toBe(false);
    expect(mcAtMost('1.12.2', 1, 12, 2)).toBe(true);
    expect(mcAtMost('1.12.3', 1, 12, 2)).toBe(false);
    expect(mcAtMost('1.7.10', 1, 12, 2)).toBe(true);
    expect(mcAtMost('26.1', 1, 16, 5)).toBe(false);
  });

  it('maps NeoForge versions to Minecraft versions', () => {
    expect(neoForgeMcVersion('21.1.172')).toBe('1.21.1');
    expect(neoForgeMcVersion('21.0.167')).toBe('1.21');
    expect(neoForgeMcVersion('20.4.0-beta')).toBe('1.20.4');
    expect(neoForgeMcVersion('20.6.144')).toBe('1.20.6');
    expect(neoForgeMcVersion('21.11.48')).toBe('1.21.11');
    expect(neoForgeMcVersion('26.1.2.126')).toBe('26.1.2');
    expect(neoForgeMcVersion('26.3.0.101')).toBe('26.3');
    expect(neoForgeMcVersion('26.2.0.5-beta')).toBe('26.2');
    expect(neoForgeMcVersion('26.1.0.0-alpha.1+snapshot-1')).toBeNull();
    expect(neoForgeMcVersion('0.25w14craftmine.3-beta')).toBeNull();
  });
});

describe('loader lists', () => {
  it('describes the five loaders', () => {
    expect(catalog.loaders().map((l) => l.id)).toEqual(['vanilla', 'fabric', 'paper', 'neoforge', 'forge']);
    expect(catalog.loaders().find((l) => l.id === 'forge')).toMatchObject({ supportsMods: true, requiresInstallerJava: true });
    expect(catalog.loaders().find((l) => l.id === 'vanilla')?.supportsMods).toBe(false);
  });

  it('lists vanilla releases only by default and snapshots on request, without pre-1.2.5 and old betas', async () => {
    expect((await catalog.mcVersions('vanilla', false)).map((v) => v.id)).toEqual(['1.21.1', '1.20.4', '1.12.2', '1.7.10', '1.2.5']);
    const all = await catalog.mcVersions('vanilla', true);
    expect(all.find((v) => v.id === '24w14a')).toEqual({ id: '24w14a', type: 'snapshot' });
    expect(all.some((v) => v.id === 'b1.7.3' || v.id === '1.1')).toBe(false);
  });

  it('lists fabric, paper, neoforge and forge Minecraft versions', async () => {
    expect((await catalog.mcVersions('fabric', false)).map((v) => v.id)).toEqual(['1.21.1', '1.20.4']);
    expect((await catalog.mcVersions('fabric', true)).map((v) => v.id)).toContain('24w14a');
    expect((await catalog.mcVersions('paper', false)).map((v) => v.id)).toEqual(['1.21.1', '1.21', '1.20.4']);
    expect((await catalog.mcVersions('paper', true)).map((v) => v.id)).toContain('1.21.2-rc1');
    expect((await catalog.mcVersions('neoforge', false)).map((v) => v.id)).toEqual(['26.3', '26.1.2', '1.21.1', '1.21', '1.20.5', '1.20.4']);
    expect((await catalog.mcVersions('forge', false)).map((v) => v.id)).toEqual(['1.21.1', '1.20.1', '1.12.2', '1.7.10', '1.7.2']);
  });

  it('lists loader versions with stable and recommended flags', async () => {
    const fabric = await catalog.versions('fabric', '1.21.1');
    expect(fabric.map((v) => v.version)).toEqual(['0.17.0-beta.1', '0.16.14', '0.16.10']);
    expect(fabric.find((v) => v.recommended)?.version).toBe('0.16.14');
    expect(fabric[0]?.stable).toBe(false);

    const paper = await catalog.versions('paper', '1.21.1');
    expect(paper.map((v) => [v.version, v.stable, v.recommended])).toEqual([
      ['135', false, false],
      ['133', true, true],
      ['132', true, false],
    ]);

    const neo = await catalog.versions('neoforge', '1.21.1');
    expect(neo.map((v) => v.version)).toEqual(['21.1.173-beta', '21.1.172', '21.1.9', '21.1.1']);
    expect(neo.find((v) => v.recommended)?.version).toBe('21.1.172');

    const forge = await catalog.versions('forge', '1.21.1');
    expect(forge.map((v) => v.version)).toEqual(['52.1.21', '52.1.20', '52.1.0']);
    expect(forge.find((v) => v.recommended)?.version).toBe('52.1.20');
    const legacy = await catalog.versions('forge', '1.7.10');
    expect(legacy.find((v) => v.recommended)?.version).toBe('10.13.4.1614-1.7.10');

    expect(await catalog.versions('vanilla', '1.21.1')).toEqual([]);
  });

  it('excludes NeoForge for 1.20.1 explicitly and reports unknown versions as VERSION_NOT_FOUND', async () => {
    const neo = await failure(catalog.versions('neoforge', '1.20.1'));
    expect(neo).toMatchObject({ statusCode: 404, code: 'VERSION_NOT_FOUND' });
    expect(neo.message).toContain('Forge');
    for (const [loader, mc] of [
      ['vanilla', '9.9.9'],
      ['fabric', '1.7.10'],
      ['paper', 'nope'],
      ['neoforge', '9.9'],
      ['forge', '1.6.4'],
      ['forge', '9.9'],
    ] as const) {
      expect(await failure(catalog.versions(loader, mc)), `${loader} ${mc}`).toMatchObject({ statusCode: 404, code: 'VERSION_NOT_FOUND' });
    }
  });
});

describe('resolving installs', () => {
  const expectHosts = (plan: ResolvedInstall): void => {
    expect(plan.artifact.allowedHosts.length).toBeGreaterThan(0);
    for (const host of plan.artifact.allowedHosts) expect(INSTALLER_DOWNLOAD_HOSTS).toContain(host);
    expect(plan.artifact.allowedHosts).toContain(new URL(plan.artifact.url).hostname);
  };

  it('vanilla: sha1 + size from the Mojang version JSON and the Java major', async () => {
    const plan = await catalog.resolve('vanilla', '1.21.1', null);
    expect(plan).toMatchObject({ loaderVersion: null, requiredJavaMajor: 21, mode: { kind: 'jar', launchJar: 'server.jar' } });
    expect(plan.artifact.hash?.algorithm).toBe('sha1');
    expect(plan.artifact.hash?.value).toBe(sha('sha1', zipBytes('vanilla-1.21.1')));
    expect(plan.artifact.size).toBe(zipBytes('vanilla-1.21.1').length);
    expectHosts(plan);
    expect((await catalog.resolve('vanilla', '1.12.2', null)).requiredJavaMajor).toBe(8);
  });

  it('vanilla: a version without a server download gives a clear error', async () => {
    const error = await failure(catalog.resolve('vanilla', '1.1', null));
    expect(error).toMatchObject({ statusCode: 422, code: 'NO_SERVER_DOWNLOAD' });
    expect(error.message).toContain('1.1');
  });

  it('fabric: builds the launcher URL from loader and the latest stable installer, no hash, zip check on', async () => {
    const plan = await catalog.resolve('fabric', '1.21.1', null);
    expect(plan.loaderVersion).toBe('0.16.14');
    expect(plan.artifact.url).toBe('https://meta.fabricmc.net/v2/versions/loader/1.21.1/0.16.14/1.0.1/server/jar');
    expect(plan.artifact.hash).toBeUndefined();
    expect(plan.artifact.requireZip).toBe(true);
    expect(plan.requiredJavaMajor).toBe(21);
    expect(plan.mode).toEqual({ kind: 'jar', launchJar: 'fabric-server-launch.jar' });
    expectHosts(plan);
    expect((await catalog.resolve('fabric', '1.21.1', '0.16.10')).loaderVersion).toBe('0.16.10');
    expect(await failure(catalog.resolve('fabric', '1.21.1', '9.9.9'))).toMatchObject({ code: 'VERSION_NOT_FOUND' });
  });

  it('paper: prefers the newest stable build, uses the sha256 and notes unstable fallbacks', async () => {
    const plan = await catalog.resolve('paper', '1.21.1', null);
    expect(plan.loaderVersion).toBe('133');
    expect(plan.artifact).toMatchObject({ fileName: 'paper-1.21.1-133.jar', hash: { algorithm: 'sha256', value: sha('sha256', zipBytes('paper-133')) } });
    expect(plan.notes).toEqual([]);
    expect(plan.requiredJavaMajor).toBe(21);
    expectHosts(plan);
    const beta = await catalog.resolve('paper', '1.20.4', null);
    expect(beta.loaderVersion).toBe('500');
    expect(beta.notes[0]).toContain('no stable build');
    expect((await catalog.resolve('paper', '1.21.1', '135')).notes).toHaveLength(1);
  });

  it('paper: sends the User-Agent', async () => {
    await catalog.resolve('paper', '1.21.1', null);
    expect(upstream.headers.length).toBeGreaterThan(0);
    for (const headers of upstream.headers) expect(headers['User-Agent']).toBe('test-agent/1.0');
  });

  it('neoforge: installer URL, sha256 sidecar and --install-server', async () => {
    const plan = await catalog.resolve('neoforge', '1.21.1', null);
    expect(plan.loaderVersion).toBe('21.1.172');
    expect(plan.artifact.url).toBe('https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.172/neoforge-21.1.172-installer.jar');
    expect(plan.artifact.hash).toEqual({ algorithm: 'sha256', value: sha('sha256', zipBytes('neoforge-21.1.172')) });
    expect(plan.mode).toEqual({ kind: 'installer', arguments: ['--install-server'] });
    expect(plan.requiredJavaMajor).toBe(21);
    expectHosts(plan);
    expect((await catalog.resolve('neoforge', '1.20.4', null)).requiredJavaMajor).toBe(17);
  });

  it('forge: recommended build, --installServer and the best available checksum', async () => {
    const plan = await catalog.resolve('forge', '1.21.1', null);
    expect(plan.loaderVersion).toBe('52.1.20');
    expect(plan.artifact.url).toBe('https://maven.minecraftforge.net/net/minecraftforge/forge/1.21.1-52.1.20/forge-1.21.1-52.1.20-installer.jar');
    expect(plan.artifact.hash).toEqual({ algorithm: 'sha512', value: sha('sha512', zipBytes('forge-1.21.1-52.1.20')) });
    expect(plan.mode).toEqual({ kind: 'installer', arguments: ['--installServer'] });
    expectHosts(plan);

    const legacy = await catalog.resolve('forge', '1.12.2', null);
    expect(legacy.loaderVersion).toBe('14.23.5.2864');
    expect(legacy.artifact.hash?.algorithm).toBe('sha1');
    expect(legacy.requiredJavaMajor).toBe(8);

    const old = await catalog.resolve('forge', '1.7.10', null);
    expect(old.loaderVersion).toBe('10.13.4.1614-1.7.10');
    expect(old.artifact.url).toContain('1.7.10-10.13.4.1614-1.7.10/forge-1.7.10-10.13.4.1614-1.7.10-installer.jar');
  });

  it('forge: refuses to install without any published checksum', async () => {
    upstream.text.delete('https://maven.minecraftforge.net/net/minecraftforge/forge/1.21.1-52.1.20/forge-1.21.1-52.1.20-installer.jar.sha512');
    upstream.text.delete('https://maven.minecraftforge.net/net/minecraftforge/forge/1.21.1-52.1.20/forge-1.21.1-52.1.20-installer.jar.sha256');
    expect(await failure(catalog.resolve('forge', '1.21.1', null))).toMatchObject({ statusCode: 502, code: 'CHECKSUM_UNAVAILABLE' });
  });
});

describe('upstream failures and caching', () => {
  it('maps an unreachable service to UPSTREAM_UNREACHABLE (502)', async () => {
    upstream.down = true;
    const error = await failure(catalog.mcVersions('vanilla', false));
    expect(error).toMatchObject({ statusCode: 502, code: 'UPSTREAM_UNREACHABLE' });
    expect(error.message).toContain('piston-meta.mojang.com');
    // the host is a parameter, so a translated text can name it as well
    expect(error).toMatchObject({ params: { host: 'piston-meta.mojang.com' }, details: { host: 'piston-meta.mojang.com' } });
  });

  it('maps a hanging service to UPSTREAM_TIMEOUT (504)', async () => {
    upstream.hangOn.add('https://meta.fabricmc.net/v2/versions/game');
    expect(await failure(catalog.mcVersions('fabric', false))).toMatchObject({ statusCode: 504, code: 'UPSTREAM_TIMEOUT' });
  });

  it('maps HTTP 5xx and broken payloads to UPSTREAM_ERROR / UPSTREAM_INVALID', async () => {
    upstream.json.set('https://meta.fabricmc.net/v2/versions/game', { body: 'x', status: 503 });
    expect(await failure(catalog.mcVersions('fabric', false))).toMatchObject({ statusCode: 502, code: 'UPSTREAM_ERROR' });
    upstream.json.set('https://fill.papermc.io/v3/projects/paper', { body: { versions: 'broken' } });
    expect(await failure(catalog.mcVersions('paper', false))).toMatchObject({ statusCode: 502, code: 'UPSTREAM_INVALID' });
  });

  it('refuses redirects to hosts outside the allowlist', async () => {
    upstream.redirects.set('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', 'https://evil.example.com/manifest.json');
    expect(await failure(catalog.mcVersions('vanilla', false))).toMatchObject({ code: 'DOWNLOAD_URL_REJECTED' });
  });

  it('caches lists for a few minutes and refetches afterwards; failures are not cached', async () => {
    await catalog.mcVersions('forge', false);
    await catalog.mcVersions('forge', false);
    await catalog.versions('forge', '1.21.1');
    expect(upstream.count('maven-metadata.json')).toBe(1);
    now += 5 * 60_000 + 1;
    await catalog.mcVersions('forge', false);
    expect(upstream.count('maven-metadata.json')).toBe(2);

    upstream.down = true;
    await failure(catalog.mcVersions('fabric', false));
    upstream.down = false;
    expect((await catalog.mcVersions('fabric', false)).length).toBeGreaterThan(0);
  });

  it('shares one request between concurrent callers', async () => {
    await Promise.all([catalog.mcVersions('paper', false), catalog.mcVersions('paper', false), catalog.mcVersions('paper', true)]);
    expect(upstream.count('/v3/projects/paper')).toBe(1);
  });
});

describe('downloads', () => {
  const download = async (plan: ResolvedInstall): Promise<string> => {
    const dir = await scratchDir('dl-');
    return downloadToTmp(
      {
        url: plan.artifact.url,
        fileName: plan.artifact.fileName,
        ...(plan.artifact.hash === undefined ? {} : { hash: plan.artifact.hash }),
        ...(plan.artifact.size === undefined ? {} : { size: plan.artifact.size }),
        allowedHosts: plan.artifact.allowedHosts,
        requireZip: plan.artifact.requireZip,
      },
      path.join(dir, '.tmp'),
      catalog.downloader,
    );
  };

  it('downloads and verifies every loader artifact', async () => {
    for (const [loader, mc] of [
      ['vanilla', '1.21.1'],
      ['fabric', '1.21.1'],
      ['paper', '1.21.1'],
      ['neoforge', '1.21.1'],
      ['forge', '1.21.1'],
      ['forge', '1.12.2'],
    ] as const) {
      const plan = await catalog.resolve(loader, mc, null);
      const file = await download(plan);
      expect((await readFile(file)).subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 3, 4]));
    }
  });

  it('rejects a corrupted download for every hash algorithm and leaves no partial file', async () => {
    for (const [loader, mc] of [
      ['vanilla', '1.21.1'],
      ['paper', '1.21.1'],
      ['neoforge', '1.21.1'],
      ['forge', '1.21.1'],
      ['forge', '1.12.2'],
    ] as const) {
      const plan = await catalog.resolve(loader, mc, null);
      upstream.corrupt.add(plan.artifact.url);
      const dir = await scratchDir('dl-');
      const error = await failure(
        downloadToTmp(
          { url: plan.artifact.url, fileName: plan.artifact.fileName, ...(plan.artifact.hash === undefined ? {} : { hash: plan.artifact.hash }), allowedHosts: plan.artifact.allowedHosts },
          path.join(dir, '.tmp'),
          catalog.downloader,
        ),
      );
      expect(error.code, `${loader} ${mc}`).toBe('DOWNLOAD_HASH_MISMATCH');
      expect(await readdir(path.join(dir, '.tmp'))).toEqual([]);
    }
  });

  it('fabric has no checksum, so ZIP magic and the host are what is checked', async () => {
    const plan = await catalog.resolve('fabric', '1.21.1', null);
    upstream.blobs.set(plan.artifact.url, Buffer.from('<html>not a jar</html>'));
    expect(await failure(download(plan))).toMatchObject({ code: 'DOWNLOAD_INVALID_FILE' });
    upstream.blobs.set(plan.artifact.url, zipBytes('x'));
    await expect(download(plan)).resolves.toContain('.part');
  });

  it('rejects a size mismatch even when no hash is available', async () => {
    const dir = await scratchDir('dl-');
    const error = await failure(
      downloadToTmp(
        { url: 'https://meta.fabricmc.net/v2/versions/loader/1.21.1/0.16.14/1.0.1/server/jar', fileName: 'x.jar', size: 3, allowedHosts: ['meta.fabricmc.net'] },
        path.join(dir, '.tmp'),
        catalog.downloader,
      ),
    );
    expect(error.code).toBe('DOWNLOAD_HASH_MISMATCH');
  });

  it('applies the per-call host allowlist to the first request and to redirects', async () => {
    const dir = await scratchDir('dl-');
    const spec = { fileName: 'x.jar', allowedHosts: ['meta.fabricmc.net'] };
    expect(
      await failure(downloadToTmp({ ...spec, url: 'https://maven.neoforged.net/x.jar' }, dir, catalog.downloader)),
    ).toMatchObject({ code: 'DOWNLOAD_URL_REJECTED' });
    expect(
      await failure(downloadToTmp({ ...spec, url: 'http://meta.fabricmc.net/x.jar' }, dir, catalog.downloader)),
    ).toMatchObject({ code: 'DOWNLOAD_URL_REJECTED' });
    upstream.redirects.set('https://meta.fabricmc.net/redirect.jar', 'https://piston-data.mojang.com/v1/objects/1.21.1/server.jar');
    expect(
      await failure(downloadToTmp({ ...spec, url: 'https://meta.fabricmc.net/redirect.jar' }, dir, catalog.downloader)),
    ).toMatchObject({ code: 'DOWNLOAD_URL_REJECTED' });
  });
});

describe('launch target detection', () => {
  const make = async (files: Record<string, string>): Promise<string> => {
    const dir = await scratchDir('launch-');
    for (const [name, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
      await writeFile(path.join(dir, name), content);
    }
    return dir;
  };

  it('finds the unix/win args files of modern Forge and NeoForge', async () => {
    const forge = await make({
      'libraries/net/minecraftforge/forge/1.21.1-52.1.20/unix_args.txt': '',
      'libraries/net/minecraftforge/forge/1.21.1-52.1.20/win_args.txt': '',
    });
    expect(await detectForgeLaunch(forge, 'forge', '1.21.1', '52.1.20')).toEqual({
      kind: 'args',
      unixFile: 'libraries/net/minecraftforge/forge/1.21.1-52.1.20/unix_args.txt',
      winFile: 'libraries/net/minecraftforge/forge/1.21.1-52.1.20/win_args.txt',
    });
    const neo = await make({
      'libraries/net/neoforged/neoforge/21.1.172/unix_args.txt': '',
      'libraries/net/neoforged/neoforge/21.1.172/win_args.txt': '',
    });
    expect((await detectForgeLaunch(neo, 'neoforge', '1.21.1', '21.1.172')).kind).toBe('args');
  });

  it('prefers the directory of the installed version when old ones are left over', async () => {
    const dir = await make({
      'libraries/net/minecraftforge/forge/1.21.1-52.1.0/unix_args.txt': '',
      'libraries/net/minecraftforge/forge/1.21.1-52.1.0/win_args.txt': '',
      'libraries/net/minecraftforge/forge/1.21.1-52.1.20/unix_args.txt': '',
      'libraries/net/minecraftforge/forge/1.21.1-52.1.20/win_args.txt': '',
      'libraries/net/minecraftforge/forge/1.21.1-52.1.30/unix_args.txt': '',
      'libraries/net/minecraftforge/forge/1.21.1-52.1.30/win_args.txt': '',
    });
    const spec = await detectForgeLaunch(dir, 'forge', '1.21.1', '52.1.20');
    expect(spec).toMatchObject({ kind: 'args', unixFile: expect.stringContaining('1.21.1-52.1.20') });
  });

  it('ignores directories that miss one of the two args files', async () => {
    const dir = await make({ 'libraries/net/minecraftforge/forge/1.21.1-52.1.20/unix_args.txt': '' });
    await expect(detectForgeLaunch(dir, 'forge', '1.21.1', '52.1.20')).rejects.toMatchObject({ code: 'LAUNCH_TARGET_NOT_FOUND' });
  });

  it('finds the exact legacy jar, a universal jar, or the only candidate', async () => {
    const exact = await make({
      'forge-1.12.2-14.23.5.2864.jar': '',
      'forge-1.12.2-14.23.5.2864-installer.jar': '',
      'minecraft_server.1.12.2.jar': '',
    });
    expect(await detectForgeLaunch(exact, 'forge', '1.12.2', '14.23.5.2864')).toEqual({ kind: 'jar', jar: 'forge-1.12.2-14.23.5.2864.jar' });
    const universal = await make({
      'forge-1.7.10-10.13.4.1614-1.7.10-universal.jar': '',
      'forge-1.7.10-10.13.4.1614-1.7.10-installer.jar': '',
      'minecraft_server.1.7.10.jar': '',
    });
    expect(await detectForgeLaunch(universal, 'forge', '1.7.10', '10.13.4.1614-1.7.10')).toEqual({
      kind: 'jar',
      jar: 'forge-1.7.10-10.13.4.1614-1.7.10-universal.jar',
    });
    const only = await make({ 'forge-1.8.9-11.15.1.2318-1.8.9.jar': '' });
    expect((await detectForgeLaunch(only, 'forge', '1.8.9', '11.15.1.2318-1.8.9')).kind).toBe('jar');
  });

  it('fails clearly when nothing launchable exists or the choice is ambiguous', async () => {
    const empty = await make({ 'readme.txt': '' });
    await expect(detectForgeLaunch(empty, 'forge', '1.12.2', 'x')).rejects.toMatchObject({ statusCode: 500, code: 'LAUNCH_TARGET_NOT_FOUND' });
    const ambiguous = await make({ 'forge-a.jar': '', 'forge-b.jar': '' });
    await expect(detectForgeLaunch(ambiguous, 'forge', '1.12.2', 'x')).rejects.toMatchObject({ code: 'LAUNCH_TARGET_NOT_FOUND' });
    await expect(detectForgeLaunch(await make({ 'forge-1.jar': '' }), 'neoforge', '1.21.1', 'x')).rejects.toMatchObject({ code: 'LAUNCH_TARGET_NOT_FOUND' });
  });
});
