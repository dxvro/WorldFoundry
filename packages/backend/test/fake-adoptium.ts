import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { JavaDetector, type JavaProbe } from '../src/java/detect.js';
import { ManagedRuntimes, type ManagedRuntimesOptions } from '../src/java/managed.js';
import { JavaService } from '../src/java/service.js';
import { KeyedLock } from '../src/lib/keyed-lock.js';
import { buildTarGz, buildZip, type TarEntry, type ZipEntry } from './archive-builders.js';

export interface FakeRuntime {
  major: number;
  os: 'windows' | 'linux' | 'mac';
  arch: 'x64' | 'aarch64';
  image: 'jre' | 'jdk';
  version?: string;
  // what the fake java file claims to be when it is executed; defaults to the major
  reportsMajor?: number;
  // adds a symlink to the tar (default: only where the test host can create one)
  symlink?: boolean;
  // serves this archive instead of a well-formed one (hostile layouts)
  archive?: Buffer;
}

const key = (major: number, os: string, arch: string, image: string): string => `${major}/${os}/${arch}/${image}`;

// Imitates api.adoptium.net, the GitHub release redirect and GitHub's asset host
export class FakeAdoptium {
  readonly requests: string[] = [];
  readonly blobs = new Map<string, Buffer>();
  private readonly assets = new Map<string, { body: unknown }>();
  private counter = 0;
  // serves different bytes than the published checksum
  tamper = false;
  // the redirect from GitHub goes to this host instead
  redirectHost: string | null = null;
  failApi = false;
  // downloads wait until the request is aborted
  hang = false;
  downloadDelayMs = 0;

  add(spec: FakeRuntime): void {
    const version = spec.version ?? `${spec.major}.0.13+9`;
    const exe = spec.os === 'windows' ? 'java.exe' : 'java';
    const topName = `jdk-${version}${spec.image === 'jre' ? '-jre' : ''}`;
    const home = spec.os === 'mac' ? `${topName}/Contents/Home` : topName;
    const javaText = `JAVA_VERSION=${spec.major === 8 ? '1.8.0_512' : `${spec.reportsMajor ?? spec.major}.0.13`}`;
    const extension = spec.os === 'windows' ? 'zip' : 'tar.gz';
    let archive: Buffer;
    if (spec.os === 'windows') {
      const entries: ZipEntry[] = [
        { name: `${topName}/` },
        { name: `${home}/bin/` },
        { name: `${home}/bin/${exe}`, content: javaText },
        { name: `${home}/release`, content: `JAVA_VERSION="${spec.major}"` },
        { name: `${home}/lib/modules`, content: Buffer.alloc(40_000, 1) },
      ];
      archive = buildZip(entries);
    } else {
      const entries: TarEntry[] = [
        { name: `${topName}/`, type: '5', mode: 0o755 },
        { name: `${home}/bin/`, type: '5', mode: 0o755 },
        { name: `${home}/bin/${exe}`, content: javaText, mode: 0o755 },
        { name: `${home}/release`, content: `JAVA_VERSION="${spec.major}"` },
        { name: `${home}/lib/modules`, content: Buffer.alloc(40_000, 1) },
      ];
      if (spec.symlink ?? process.platform !== 'win32') entries.push({ name: `${home}/legal-link`, type: '2', linkname: 'release' });
      archive = buildTarGz(entries);
    }
    if (spec.archive !== undefined) archive = spec.archive;
    const fileName = `OpenJDK${spec.major}U-${spec.image}_${spec.arch}_${spec.os}_hotspot_${version.replace('+', '_')}.${extension}`;
    const tag = `jdk-${version}`.replace('+', '%2B');
    const link = `https://github.com/adoptium/temurin${spec.major}-binaries/releases/download/${tag}/${fileName}`;
    this.blobs.set(link, archive);
    this.assets.set(key(spec.major, spec.os, spec.arch, spec.image), {
      body: [
        {
          binary: {
            architecture: spec.arch,
            os: spec.os,
            image_type: spec.image,
            package: {
              checksum: createHash('sha256').update(archive).digest('hex'),
              link,
              name: fileName,
              size: archive.length,
            },
          },
          release_name: `jdk-${version}`,
          version: { major: spec.major, openjdk_version: `${version}-LTS` },
        },
      ],
    });
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    this.requests.push(url.href);
    if (url.hostname === 'api.adoptium.net') {
      if (this.failApi) return new Response('broken', { status: 500 });
      const match = /^\/v3\/assets\/latest\/(\d+)\/hotspot$/.exec(url.pathname);
      if (match === null) return new Response('not found', { status: 404 });
      const entry = this.assets.get(key(Number(match[1]), url.searchParams.get('os') ?? '', url.searchParams.get('architecture') ?? '', url.searchParams.get('image_type') ?? ''));
      return new Response(JSON.stringify(entry === undefined ? [] : entry.body), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.hostname === 'github.com') {
      if (!this.blobs.has(url.href)) return new Response('not found', { status: 404 });
      const host = this.redirectHost ?? 'release-assets.githubusercontent.com';
      return new Response(null, { status: 302, headers: { location: `https://${host}/asset?u=${encodeURIComponent(url.href)}&n=${this.counter++}` } });
    }
    if (url.hostname === 'release-assets.githubusercontent.com') {
      const blob = this.blobs.get(url.searchParams.get('u') ?? '');
      if (blob === undefined) return new Response('not found', { status: 404 });
      if (this.hang) {
        await new Promise<void>((_, reject) => {
          const abort = (): void => reject(new DOMException('aborted', 'AbortError'));
          if (init?.signal?.aborted === true) abort();
          else init?.signal?.addEventListener('abort', abort, { once: true });
        });
      }
      if (this.downloadDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.downloadDelayMs));
      const body = this.tamper ? Buffer.concat([blob.subarray(0, blob.length - 1), Buffer.from('X')]) : blob;
      return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } });
    }
    return new Response('unexpected host', { status: 500 });
  };

  hostsContacted(): string[] {
    return [...new Set(this.requests.map((request) => new URL(request).hostname))];
  }
}

// "java -version" of the fake runtimes: the executable is a text file naming its version
export const fakeProbe: JavaProbe = async (javaPath) => {
  const text = await readFile(javaPath, 'utf8').catch(() => null);
  const match = text === null ? null : /^JAVA_VERSION=(\S+)$/.exec(text.trim());
  if (match?.[1] === undefined) return null;
  return `openjdk version "${match[1]}" 2025-01-01\nOpenJDK Runtime Environment Temurin-${match[1]}+9 (build ${match[1]}+9)\n`;
};

export interface ManagedKit {
  managed: ManagedRuntimes;
  java: JavaService;
  adoptium: FakeAdoptium;
  dir: string;
}

// A Java service whose only runtimes are the managed ones; every other path "does not exist" for the probe
export function managedKit(dataDir: string, options: Partial<ManagedRuntimesOptions> & { autoInstall?: boolean; adoptium?: FakeAdoptium } = {}): ManagedKit {
  const adoptium = options.adoptium ?? new FakeAdoptium();
  const dir = path.join(dataDir, 'runtimes');
  const probe = options.probe ?? fakeProbe;
  const managed = new ManagedRuntimes({
    dir,
    fetch: adoptium.fetch,
    userAgent: 'test-agent/1.0',
    lock: new KeyedLock(),
    probe,
    ...options,
  });
  const detector = new JavaDetector({ env: {}, platform: options.platform ?? process.platform, standardRoots: [], probe, managed: { list: () => managed.sources() } });
  return { managed, java: new JavaService(detector, managed, options.autoInstall ?? true), adoptium, dir };
}
