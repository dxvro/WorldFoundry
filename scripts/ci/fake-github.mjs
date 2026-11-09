#!/usr/bin/env node
// Fake GitHub for the update test in CI: imitates api.github.com and the release downloads.
//
//   node scripts/ci/fake-github.mjs --dir <folder> --port 4599 --repo ci/test
//
// <folder>/<tag>/ contains the files of each release (package, SHA256SUMS.txt, SHA256SUMS.txt.sig) and optionally
// release.json ({ "prerelease": true, "notes": "..." }). The folder is read again on every request, so a test can
// create further releases while it runs.
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { dir: { type: 'string' }, port: { type: 'string', default: '4599' }, repo: { type: 'string', default: 'ci/test' } }, strict: true });
if (values.dir === undefined) {
  console.error('--dir is missing');
  process.exit(2);
}
const root = path.resolve(values.dir);
const port = Number(values.port);
const base = `http://127.0.0.1:${port}`;

async function listReleases() {
  const releases = [];
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !/^v\d/.test(entry.name)) continue;
    const dir = path.join(root, entry.name);
    const meta = JSON.parse(await readFile(path.join(dir, 'release.json'), 'utf8').catch(() => '{}'));
    const assets = [];
    for (const name of await readdir(dir)) {
      if (name === 'release.json') continue;
      assets.push({ name, size: (await stat(path.join(dir, name))).size, browser_download_url: `${base}/download/${entry.name}/${name}` });
    }
    releases.push({
      tag_name: entry.name,
      name: `WorldFoundry ${entry.name.slice(1)}`,
      body: meta.notes ?? `Test release ${entry.name}`,
      draft: false,
      prerelease: meta.prerelease === true,
      html_url: `${base}/release/${entry.name}`,
      published_at: new Date().toISOString(),
      assets,
    });
  }
  return releases;
}

createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', base);
  console.log(`${request.method} ${url.pathname}`);
  try {
    if (url.pathname === `/repos/${values.repo}/releases`) {
      const body = JSON.stringify(await listReleases());
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(body);
      return;
    }
    const match = /^\/download\/(v[^/]+)\/([^/]+)$/.exec(url.pathname);
    if (match !== null && !match[1].includes('..') && !match[2].includes('..')) {
      const file = path.join(root, match[1], decodeURIComponent(match[2]));
      const info = await stat(file);
      response.writeHead(200, { 'content-length': info.size, 'content-type': 'application/octet-stream' });
      createReadStream(file).pipe(response);
      return;
    }
    response.writeHead(404).end('not found');
  } catch (error) {
    console.error(error);
    if (!response.headersSent) response.writeHead(404).end('not found');
    else response.destroy();
  }
}).listen(port, '127.0.0.1', () => console.log(`Fake GitHub at ${base} (repository ${values.repo}, folder ${root})`));
