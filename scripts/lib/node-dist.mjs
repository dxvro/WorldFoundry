// Selection and addresses of the official Node.js runtime (pure logic) and permissions of the unpacked executable.
import { chmod, writeFile } from 'node:fs/promises';

export const NODE_DIST_HOST = 'nodejs.org';
export const NODE_DIST_BASE = `https://${NODE_DIST_HOST}/dist`;

function compareVersions(a, b) {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// index.json from nodejs.org/dist: newest version that belongs to an LTS line
export function selectLts(index) {
  if (!Array.isArray(index)) throw new Error('Unexpected format of nodejs.org/dist/index.json');
  const lts = index.filter((entry) => typeof entry?.version === 'string' && typeof entry.lts === 'string');
  if (lts.length === 0) throw new Error('No LTS version found in index.json.');
  lts.sort((a, b) => compareVersions(b.version, a.version));
  return lts[0].version;
}

export function nodeDistUrl(version, fileName) {
  return `${NODE_DIST_BASE}/${version}/${fileName}`;
}

// Paths inside the official archive
export function nodeArchiveEntries(version, target) {
  const root = `node-${version}-${target.nodeDist}`;
  return target.platform === 'win32'
    ? { binary: `${root}/node.exe`, license: `${root}/LICENSE` }
    : { binary: `${root}/bin/node`, license: `${root}/LICENSE` };
}

// File permissions of the unpacked Node executable: tar supplies the execute bit, zip (Windows) does not need it
export function nodeBinaryMode(entryMode, target) {
  if (target.platform === 'win32') return 0o755;
  // Make sure everyone has the execute bit, even if the archive entry carries no permissions
  return ((entryMode & 0o777) | 0o755) & 0o777;
}

// Writes the file and then sets the permissions explicitly once more (the writeFile mode is subject to the umask)
export async function writeExecutable(file, data, mode) {
  await writeFile(file, data, { mode });
  await chmod(file, mode);
}
