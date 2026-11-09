// Install the production dependencies of the backend for a target system into an intermediate folder.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { parseTar } from './archive.mjs';
import { verifyIntegrity } from './checksums.mjs';
import { downloadBuffer } from './download.mjs';
import { NPM_REGISTRY_HOSTS } from './pins.mjs';
import { foreignLibsqlPackages } from './targets.mjs';

// npm options so that npm picks the optional packages of the TARGET instead of the build machine
export function npmPlatformFlags(target) {
  const flags = [`--os=${target.platform}`, `--cpu=${target.arch}`];
  if (target.platform === 'linux') flags.push('--libc=glibc');
  return flags;
}

// Directories that are never needed at runtime (tests including test data, partly with special characters in
// their names that some ZIP tools choke on)
export function isPrunableDirName(name) {
  return ['test', 'tests', '__tests__', '.github'].includes(name);
}

export async function pruneNodeModules(nodeModules) {
  let removed = 0;
  const visit = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (isPrunableDirName(entry.name)) {
        await rm(full, { recursive: true, force: true });
        removed += 1;
      } else {
        await visit(full);
      }
    }
  };
  await visit(nodeModules);
  return removed;
}

// All paths must be plain ASCII so that the archives can be extracted anywhere
export async function findNonAsciiPaths(dir, base = dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (/[^ -~]/.test(entry.name)) found.push(path.relative(base, full));
    if (entry.isDirectory()) found.push(...(await findNonAsciiPaths(full, base)));
  }
  return found;
}

export function lockEntry(lock, packageName) {
  const entry = lock?.packages?.[`node_modules/${packageName}`];
  if (entry === undefined || typeof entry.resolved !== 'string' || typeof entry.integrity !== 'string') {
    throw new Error(`${packageName} is not listed (with a checksum) in package-lock.json.`);
  }
  return entry;
}

function run(command, args, options) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32', ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (status ${result.status ?? result.error?.message}).`);
}

// Finds the JavaScript file of npm: set by npm (npm_execpath) or next to the Node installation
function findNpmCli() {
  const given = process.env['npm_execpath'];
  const nodeDir = path.dirname(process.execPath);
  const candidates = [given, path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  return candidates.find((file) => typeof file === 'string' && file.endsWith('.js') && existsSync(file));
}

export function runNpm(args, options) {
  // Start npm directly with Node (no shell call, no quoting problems); otherwise through the shell
  const cli = findNpmCli();
  if (cli !== undefined) run(process.execPath, [cli, ...args], { ...options, shell: false });
  else run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, options);
}

// Fetches an npm package directly from the registry (address and SHA-512 come from package-lock.json)
async function installFromLock({ lock, packageName, nodeModules }) {
  const entry = lockEntry(lock, packageName);
  const buffer = await downloadBuffer(entry.resolved, NPM_REGISTRY_HOSTS);
  if (!verifyIntegrity(buffer, entry.integrity)) throw new Error(`Integrity check of ${packageName} failed.`);
  const target = path.join(nodeModules, ...packageName.split('/'));
  await rm(target, { recursive: true, force: true });
  for (const item of parseTar(zlib.gunzipSync(buffer))) {
    if (item.type !== 'file') continue;
    const relative = item.path.replace(/^package\//, '');
    const destination = path.join(target, relative);
    if (!destination.startsWith(target + path.sep)) throw new Error(`Disallowed path in package ${packageName}: ${item.path}`);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, item.data);
  }
}

export async function stageProduction({ root, stagingDir, target, log }) {
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(path.join(stagingDir, 'packages', 'backend'), { recursive: true });
  await mkdir(path.join(stagingDir, 'packages', 'frontend'), { recursive: true });
  for (const file of ['package.json', 'package-lock.json', 'packages/backend/package.json', 'packages/frontend/package.json']) {
    await cp(path.join(root, file), path.join(stagingDir, file));
  }
  log(`npm ci --omit=dev for ${target.name} ...`);
  runNpm(
    ['ci', '--omit=dev', '--workspace', '@worldfoundry/backend', '--include-workspace-root=false', '--ignore-scripts', '--no-audit', '--no-fund', ...npmPlatformFlags(target)],
    { cwd: stagingDir },
  );
  const nodeModules = path.join(stagingDir, 'node_modules');
  // Links to the workspaces, type packages and start-script links are not needed at runtime
  for (const name of ['@worldfoundry', '@types', 'undici-types', '.bin', '.package-lock.json']) {
    await rm(path.join(nodeModules, name), { recursive: true, force: true });
  }
  log(`  removed test folders in node_modules: ${await pruneNodeModules(nodeModules)}`);
  const libsqlDir = path.join(nodeModules, '@libsql');
  const installed = (await readdir(libsqlDir)).map((name) => `@libsql/${name}`);
  for (const foreign of foreignLibsqlPackages(installed, target)) {
    await rm(path.join(nodeModules, ...foreign.split('/')), { recursive: true, force: true });
    log(`  removed: ${foreign} (different target system)`);
  }
  if (!installed.includes(target.libsql)) {
    log(`  ${target.libsql} is missing after npm ci, fetching it from the registry (checksum from package-lock.json)`);
    const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
    await installFromLock({ lock, packageName: target.libsql, nodeModules });
  }
  const odd = await findNonAsciiPaths(nodeModules);
  if (odd.length > 0) throw new Error('File names with special characters in node_modules (not portable): ' + odd.join(', '));
  return nodeModules;
}
