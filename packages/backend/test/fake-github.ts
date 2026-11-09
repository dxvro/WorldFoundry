import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';

export interface TestKeys {
  privateKey: KeyObject;
  publicPem: string;
}

export function makeKeys(): TestKeys {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

export const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

export interface FakeReleaseOptions {
  version: string;
  repo?: string;
  prerelease?: boolean;
  draft?: boolean;
  notes?: string;
  platform?: string; // asset suffix, default linux-x64.tar.gz
  keys: TestKeys;
  // signs with another key
  signWith?: TestKeys;
  // asset bytes differ from what the sums say
  tamperAsset?: boolean;
  // sums changed after signing
  tamperSums?: boolean;
  withoutSignature?: boolean;
  assetBytes?: Buffer;
}

export interface BuiltRelease {
  tag: string;
  json: Record<string, unknown>;
  files: Map<string, Buffer>;
  assetName: string;
}

export function buildRelease(options: FakeReleaseOptions): BuiltRelease {
  const repo = options.repo ?? 'owner/repo';
  const tag = `v${options.version}`;
  const assetName = `worldfoundry-${options.version}-${options.platform ?? 'linux-x64.tar.gz'}`;
  const original = options.assetBytes ?? Buffer.from(`package ${options.version} ${'x'.repeat(2000)}`);
  const sums = Buffer.from(`${sha256(original)}  ${assetName}\r\n${sha256('other')}  worldfoundry-other.zip\r\n`);
  const signature = sign(null, sums, (options.signWith ?? options.keys).privateKey).toString('base64');
  const files = new Map<string, Buffer>();
  files.set(assetName, options.tamperAsset === true ? Buffer.concat([Buffer.from([original[0]! ^ 0xff]), original.subarray(1)]) : original);
  files.set('SHA256SUMS.txt', options.tamperSums === true ? Buffer.from(sums.toString().replace(sha256(original), sha256('x'))) : sums);
  if (options.withoutSignature !== true) files.set('SHA256SUMS.txt.sig', Buffer.from(`${signature}\n`));
  const assets = [...files].map(([name, bytes]) => ({
    name,
    size: name === assetName ? original.length : bytes.length,
    browser_download_url: `https://github.com/${repo}/releases/download/${tag}/${name}`,
  }));
  return {
    tag,
    assetName,
    files,
    json: {
      tag_name: tag,
      name: `WorldFoundry ${options.version}`,
      body: options.notes ?? `New in ${options.version}`,
      draft: options.draft ?? false,
      prerelease: options.prerelease ?? false,
      html_url: `https://github.com/${repo}/releases/tag/${tag}`,
      published_at: '2026-11-05T10:00:00Z',
      assets,
    },
  };
}

// Stand-in for api.github.com, github.com and the CDN behind its redirects
export class FakeGithub {
  readonly releases: BuiltRelease[] = [];
  readonly requests: Array<{ url: string; headers: Record<string, string> }> = [];
  apiStatus = 200;
  // optional hook: rewrites the redirect target of downloads (host allowlist tests)
  redirectHost = 'release-assets.githubusercontent.com';

  add(release: BuiltRelease): BuiltRelease {
    this.releases.push(release);
    return release;
  }

  get hosts(): string[] {
    return [...new Set(this.requests.map((entry) => new URL(entry.url).hostname))];
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    this.requests.push({ url: url.href, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    if (init?.redirect !== 'manual') throw new Error('Updates must check redirects themselves (redirect: manual).');
    if (url.hostname === 'api.github.com' && /\/repos\/[^/]+\/[^/]+\/releases$/.test(url.pathname)) {
      if (this.apiStatus !== 200) return new Response('{"message":"Server Error"}', { status: this.apiStatus });
      return new Response(JSON.stringify(this.releases.map((release) => release.json)), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const download = /^\/[^/]+\/[^/]+\/releases\/download\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (url.hostname === 'github.com' && download !== null) {
      const target = new URL(`https://${this.redirectHost}/github-production-release-asset/1/${download[1]}/${download[2]}?sig=abc`);
      return new Response(null, { status: 302, headers: { location: target.href } });
    }
    const asset = /^\/github-production-release-asset\/1\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (url.hostname === this.redirectHost && asset !== null) {
      const release = this.releases.find((entry) => entry.tag === asset[1]);
      const bytes = release?.files.get(decodeURIComponent(asset[2] as string));
      if (bytes === undefined) return new Response('not found', { status: 404 });
      return new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-length': String(bytes.length) } });
    }
    return new Response('not found', { status: 404 });
  };
}
