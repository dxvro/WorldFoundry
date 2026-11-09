import { createHash } from 'node:crypto';

const sha = (algorithm: string, data: Buffer): string => createHash(algorithm).update(data).digest('hex');

export const zipBytes = (label: string): Buffer => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(`fake-jar:${label}`)]);

interface JsonRoute {
  body: unknown;
  status?: number;
}

// Serves just enough of Mojang, Fabric, Paper, NeoForge and Forge for the installers to be tested offline.
export class FakeUpstream {
  readonly requests: URL[] = [];
  readonly headers: Array<Record<string, string>> = [];
  readonly json = new Map<string, JsonRoute>();
  readonly blobs = new Map<string, Buffer>();
  readonly text = new Map<string, string>();
  readonly redirects = new Map<string, string>();
  readonly corrupt = new Set<string>();
  readonly hangOn = new Set<string>();
  down = false;

  constructor() {
    this.seed();
  }

  private blob(url: string, label: string): Buffer {
    const data = zipBytes(label);
    this.blobs.set(url, data);
    return data;
  }

  private seed(): void {
    const versions: Array<{ id: string; type: string; java: number; server: boolean; releaseTime: string }> = [
      { id: '1.21.1', type: 'release', java: 21, server: true, releaseTime: '2024-08-08T12:24:45+00:00' },
      { id: '1.20.4', type: 'release', java: 17, server: true, releaseTime: '2023-12-07T12:56:20+00:00' },
      { id: '1.12.2', type: 'release', java: 8, server: true, releaseTime: '2017-09-18T08:39:46+00:00' },
      { id: '1.7.10', type: 'release', java: 8, server: true, releaseTime: '2014-05-14T17:29:23+00:00' },
      { id: '1.2.5', type: 'release', java: 8, server: true, releaseTime: '2012-03-29T22:00:00+00:00' },
      { id: '1.1', type: 'release', java: 8, server: false, releaseTime: '2012-01-12T22:00:00+00:00' },
      { id: '24w14a', type: 'snapshot', java: 21, server: true, releaseTime: '2024-04-03T12:00:00+00:00' },
      { id: 'b1.7.3', type: 'old_beta', java: 8, server: false, releaseTime: '2011-07-08T00:00:00+00:00' },
    ];
    const manifest = {
      latest: { release: '1.21.1', snapshot: '24w14a' },
      versions: versions.map((v) => ({
        id: v.id,
        type: v.type,
        url: `https://piston-meta.mojang.com/v1/packages/${v.id}/${v.id}.json`,
        releaseTime: v.releaseTime,
      })),
    };
    this.json.set('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', { body: manifest });
    for (const v of versions) {
      const jar = this.blob(`https://piston-data.mojang.com/v1/objects/${v.id}/server.jar`, `vanilla-${v.id}`);
      this.json.set(`https://piston-meta.mojang.com/v1/packages/${v.id}/${v.id}.json`, {
        body: {
          id: v.id,
          javaVersion: { component: 'x', majorVersion: v.java },
          downloads: v.server
            ? { server: { url: `https://piston-data.mojang.com/v1/objects/${v.id}/server.jar`, sha1: sha('sha1', jar), size: jar.length } }
            : {},
        },
      });
    }

    this.json.set('https://meta.fabricmc.net/v2/versions/game', {
      body: [
        { version: '24w14a', stable: false },
        { version: '1.21.1', stable: true },
        { version: '1.20.4', stable: true },
      ],
    });
    for (const mc of ['1.21.1', '1.20.4']) {
      this.json.set(`https://meta.fabricmc.net/v2/versions/loader/${mc}`, {
        body: [
          { loader: { version: '0.17.0-beta.1', stable: false } },
          { loader: { version: '0.16.14', stable: true } },
          { loader: { version: '0.16.10', stable: true } },
        ],
      });
      this.blob(`https://meta.fabricmc.net/v2/versions/loader/${mc}/0.16.14/1.0.1/server/jar`, `fabric-${mc}`);
    }
    this.json.set('https://meta.fabricmc.net/v2/versions/loader/1.7.10', { body: [], status: 400 });
    this.json.set('https://meta.fabricmc.net/v2/versions/installer', {
      body: [
        { version: '1.1.0-rc1', stable: false },
        { version: '1.0.1', stable: true },
      ],
    });

    this.json.set('https://fill.papermc.io/v3/projects/paper', {
      body: { versions: { '1.21': ['1.21.1', '1.21', '1.21.2-rc1'], '1.20': ['1.20.4'] } },
    });
    const paperJar = this.blob('https://fill-data.papermc.io/v1/objects/x/paper-1.21.1-133.jar', 'paper-133');
    const paperBuild = (id: number, channel: string, jar: Buffer, name: string, url: string): object => ({
      id,
      channel,
      downloads: { 'server:default': { name, url, size: jar.length, checksums: { sha256: sha('sha256', jar) } } },
    });
    this.json.set('https://fill.papermc.io/v3/projects/paper/versions/1.21.1/builds', {
      body: [
        paperBuild(135, 'ALPHA', paperJar, 'paper-1.21.1-135.jar', 'https://fill-data.papermc.io/v1/objects/x/paper-1.21.1-133.jar'),
        paperBuild(133, 'STABLE', paperJar, 'paper-1.21.1-133.jar', 'https://fill-data.papermc.io/v1/objects/x/paper-1.21.1-133.jar'),
        paperBuild(132, 'STABLE', paperJar, 'paper-1.21.1-132.jar', 'https://fill-data.papermc.io/v1/objects/x/paper-1.21.1-133.jar'),
      ],
    });
    this.json.set('https://fill.papermc.io/v3/projects/paper/versions/1.21.1', {
      body: { version: { id: '1.21.1', java: { version: { minimum: 21 } } } },
    });
    this.json.set('https://fill.papermc.io/v3/projects/paper/versions/1.20.4/builds', {
      body: [paperBuild(500, 'BETA', paperJar, 'paper-1.20.4-500.jar', 'https://fill-data.papermc.io/v1/objects/x/paper-1.21.1-133.jar')],
    });
    this.json.set('https://fill.papermc.io/v3/projects/paper/versions/nope/builds', { body: { ok: false }, status: 404 });

    this.json.set('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge', {
      body: {
        isSnapshot: false,
        versions: [
          '0.25w14craftmine.3-beta',
          '20.4.0-beta',
          '20.4.237',
          '20.5.1-beta',
          '21.0.5',
          '21.1.1',
          '21.1.9',
          '21.1.172',
          '21.1.173-beta',
          '26.1.0.0-alpha.1+snapshot-1',
          '26.1.2.3',
          '26.3.0.99',
        ],
      },
    });
    for (const version of ['21.1.172', '21.1.9', '20.4.237']) {
      const url = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${version}/neoforge-${version}-installer.jar`;
      const jar = this.blob(url, `neoforge-${version}`);
      this.text.set(`${url}.sha256`, `${sha('sha256', jar)}\n`);
    }

    this.json.set('https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json', {
      body: {
        '1.21.1': ['1.21.1-52.1.0', '1.21.1-52.1.20', '1.21.1-52.1.21'],
        '1.20.1': ['1.20.1-47.4.28'],
        '1.12.2': ['1.12.2-14.23.5.2859', '1.12.2-14.23.5.2864'],
        '1.7.10': ['1.7.10-10.13.4.1558-1.7.10', '1.7.10-10.13.4.1614-1.7.10'],
        '1.7.2': ['1.7.2-10.12.2.1161-mc172'],
        '1.6.4': ['1.6.4-9.11.1.1345'],
        '1.7.10_pre4': ['1.7.10_pre4-10.12.2.1149-prerelease'],
      },
    });
    this.json.set('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json', {
      body: {
        promos: {
          '1.21.1-latest': '52.1.21',
          '1.21.1-recommended': '52.1.20',
          '1.12.2-latest': '14.23.5.2864',
          '1.7.10-latest': '10.13.4.1614',
          '1.7.10-recommended': '10.13.4.1614',
        },
      },
    });
    for (const full of ['1.21.1-52.1.20', '1.12.2-14.23.5.2864', '1.7.10-10.13.4.1614-1.7.10']) {
      const url = `https://maven.minecraftforge.net/net/minecraftforge/forge/${full}/forge-${full}-installer.jar`;
      const jar = this.blob(url, `forge-${full}`);
      // 1.12.2 deliberately only publishes a sha1
      if (full.startsWith('1.12.2')) this.text.set(`${url}.sha1`, sha('sha1', jar));
      else {
        this.text.set(`${url}.sha256`, sha('sha256', jar));
        this.text.set(`${url}.sha512`, sha('sha512', jar));
      }
    }
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : (input as Request).url);
    this.requests.push(url);
    this.headers.push(Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)));
    if (this.down) throw new TypeError('fetch failed');
    const key = url.href;
    const redirect = this.redirects.get(key);
    if (redirect !== undefined) return new Response(null, { status: 302, headers: { location: redirect } });
    if (this.hangOn.has(key)) {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })));
      });
    }
    const route = this.json.get(key);
    if (route !== undefined) {
      return new Response(JSON.stringify(route.body), { status: route.status ?? 200, headers: { 'content-type': 'application/json' } });
    }
    const text = this.text.get(key);
    if (text !== undefined) return new Response(text);
    const blob = this.blobs.get(key);
    if (blob !== undefined) {
      return new Response(this.corrupt.has(key) ? Buffer.concat([blob.subarray(0, blob.length - 1), Buffer.from('X')]) : blob);
    }
    return new Response('missing', { status: 404 });
  };

  count(fragment: string): number {
    return this.requests.filter((url) => url.href.includes(fragment)).length;
  }
}
