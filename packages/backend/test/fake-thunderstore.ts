import type { ThunderstoreApi, ThunderstoreListing, ThunderstorePackage } from '../src/games/valheim/thunderstore.js';
import { buildZip, type ZipEntry } from './archive-builders.js';

interface FakePackage {
  namespace: string;
  name: string;
  version: string;
  dependencies?: string[];
  files: ZipEntry[];
  categories?: string[];
  // a download whose manifest names another package
  manifestName?: string;
}

// Thunderstore for tests: packages with a version each, their zips served by `fetch`
export class FakeThunderstore {
  readonly packages = new Map<string, FakePackage>();
  readonly zips = new Map<string, Buffer>();
  readonly searches: Array<{ query: string; ordering: string; page: number }> = [];

  add(pkg: FakePackage): void {
    const key = `${pkg.namespace}-${pkg.name}`;
    this.packages.set(key, pkg);
    const manifest = { name: pkg.manifestName ?? pkg.name, version_number: pkg.version, website_url: '', description: `${pkg.name} for tests`, dependencies: pkg.dependencies ?? [] };
    this.zips.set(this.url(pkg), buildZip([{ name: 'manifest.json', content: `﻿${JSON.stringify(manifest)}` }, { name: 'icon.png', content: 'png' }, { name: 'README.md', content: '# readme' }, ...pkg.files]));
  }

  // the BepInEx pack with the files the server start looks for
  addBepInEx(version = '5.4.2360'): void {
    this.add({
      namespace: 'denikson',
      name: 'BepInExPack_Valheim',
      version,
      files: [
        { name: 'BepInExPack_Valheim/BepInEx/core/BepInEx.Preloader.dll', content: `preloader ${version}` },
        { name: 'BepInExPack_Valheim/BepInEx/config/BepInEx.cfg', content: 'pack config' },
        { name: 'BepInExPack_Valheim/doorstop_libs/libdoorstop_x64.so', content: 'so' },
        { name: 'BepInExPack_Valheim/winhttp.dll', content: 'dll' },
        { name: 'BepInExPack_Valheim/doorstop_config.ini', content: '[General]' },
        { name: 'BepInExPack_Valheim/start_server_bepinex.sh', content: '#!/bin/sh' },
      ],
    });
  }

  private url(pkg: FakePackage): string {
    return `https://thunderstore.io/package/download/${pkg.namespace}/${pkg.name}/${pkg.version}/`;
  }

  readonly api: ThunderstoreApi = {
    search: async (query, ordering, page): Promise<ThunderstoreListing> => {
      this.searches.push({ query, ordering, page });
      const hits = [...this.packages.values()].filter((pkg) => pkg.name.toLowerCase().includes(query.toLowerCase()));
      return {
        count: hits.length,
        results: hits.map((pkg) => ({
          namespace: pkg.namespace,
          name: pkg.name,
          description: `${pkg.name} for tests`,
          icon_url: `https://gcdn.thunderstore.io/live/repository/icons/${pkg.namespace}-${pkg.name}.png`,
          download_count: 1000,
          is_deprecated: false,
          categories: (pkg.categories ?? []).map((slug) => ({ slug, name: slug })),
        })),
      };
    },
    package: async (namespace, name): Promise<ThunderstorePackage> => {
      const pkg = this.packages.get(`${namespace}-${name}`);
      if (pkg === undefined) {
        const { AppError } = await import('../src/http/errors.js');
        throw new AppError(404, 'THUNDERSTORE_PACKAGE_NOT_FOUND', 'not found', undefined, { name: `${namespace}-${name}` });
      }
      return {
        namespace,
        name,
        full_name: `${namespace}-${name}`,
        is_deprecated: false,
        latest: {
          namespace,
          name,
          version_number: pkg.version,
          full_name: `${namespace}-${name}-${pkg.version}`,
          description: '',
          icon: null,
          dependencies: pkg.dependencies ?? [],
          download_url: this.url(pkg),
        },
      };
    },
  };

  readonly fetch = (async (input: string | URL | Request) => {
    const zip = this.zips.get(String(input));
    return zip === undefined ? new Response('missing', { status: 404 }) : new Response(zip);
  }) as typeof fetch;
}
