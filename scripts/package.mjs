#!/usr/bin/env node
// Builds an installable package for win-x64, linux-x64 or linux-arm64.
//   npm run package -- --target win-x64
// Result: release/<target>/ (file tree) and release/worldfoundry-<version>-<target>.(zip|tar.gz)
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeUpdateFiles } from './lib/update-files.mjs';
import { readTarGz, readZip, writeTarGz, writeZip } from './lib/archive.mjs';
import { lookupShasum, parseShasums, sha256File } from './lib/checksums.mjs';
import { downloadVerified, fetchText } from './lib/download.mjs';
import { machineMatches, readMachineFromFile } from './lib/native.mjs';
import { NODE_ALLOWED_HOSTS, WINSW } from './lib/pins.mjs';
import { collectFrontendPackages, collectPackages, formatNotices, mergePackages } from './lib/notices.mjs';
import { NODE_DIST_BASE, nodeArchiveEntries, nodeBinaryMode, nodeDistUrl, selectLts, writeExecutable } from './lib/node-dist.mjs';
import { describeSpawnFailure } from './lib/probe.mjs';
import { runNpm, stageProduction } from './lib/stage.mjs';
import { getTarget, hostTargetName, nodeArchiveName, parseArgs, releaseBaseName, TARGET_NAMES, unitForTarget } from './lib/targets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE = path.join(ROOT, 'release');
const CACHE = path.join(RELEASE, '.cache');
const log = (message) => console.log(message);

const HELP = `Usage: node scripts/package.mjs --target <${TARGET_NAMES.join('|')}> [options]

  --target <target>        target system (required)
  --skip-build             use the existing build (npm run build)
  --skip-smoke             skip the startup check of the runtime on the build machine
  --no-archive             only build the folder release/<target>/
  --node-version vX.Y.Z    a specific Node.js version instead of the latest LTS
  --out <folder>           output folder instead of release/
  --version-override X.Y.Z override the version in the package (only for the update test in CI)
  --test-update-api <URL> --test-update-key <file.pem>
                           test package: allow a local update source and a test key (CI only; creates tools/update-test.json)
`;

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function walk(dir, base = dir) {
  const result = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push({ rel: path.relative(base, full).split(path.sep).join('/'), type: 'dir', file: full });
      result.push(...(await walk(full, base)));
    } else if (entry.isFile()) {
      result.push({ rel: path.relative(base, full).split(path.sep).join('/'), type: 'file', file: full });
    }
  }
  return result;
}

// File permissions in the archive: scripts and the Node executable are executable, everything else is normal
const EXECUTABLES = new Set(['install.sh', 'uninstall.sh', 'node/node']);
const modeFor = (rel, type) => (type === 'dir' ? 0o755 : EXECUTABLES.has(rel) ? 0o755 : 0o644);

async function resolveNode(target, requested) {
  let version = requested;
  if (version === null) {
    log('Determining the current Node.js LTS version ...');
    version = selectLts(JSON.parse(await fetchText(`${NODE_DIST_BASE}/index.json`, NODE_ALLOWED_HOSTS)));
  }
  const shasums = parseShasums(await fetchText(nodeDistUrl(version, 'SHASUMS256.txt'), NODE_ALLOWED_HOSTS));
  const archiveName = nodeArchiveName(version, target);
  const archive = await downloadVerified({
    url: nodeDistUrl(version, archiveName),
    allowedHosts: NODE_ALLOWED_HOSTS,
    destination: path.join(CACHE, archiveName),
    sha256: lookupShasum(shasums, archiveName),
    label: `Node.js ${version} (${target.name})`,
  });
  return { version, archive };
}

async function extractNode({ version, archive }, target, outDir) {
  const entries = target.archiveKind === 'zip' ? await readZip(archive) : await readTarGz(archive);
  const wanted = nodeArchiveEntries(version, target);
  const binary = entries.find((e) => e.path === wanted.binary);
  const license = entries.find((e) => e.path === wanted.license);
  if (binary === undefined || license === undefined) throw new Error(`The Node archive does not contain ${wanted.binary} or ${wanted.license}.`);
  const dir = path.join(outDir, 'node');
  await mkdir(dir, { recursive: true });
  // Take the execute bit from the tar entry: without it the start fails with EACCES on Linux
  await writeExecutable(path.join(dir, target.nodeBinaryName), binary.data, nodeBinaryMode(binary.mode, target));
  const licenseText = license.data.toString('utf8');
  await writeFile(path.join(dir, 'LICENSE-node.txt'), licenseText);
  return licenseText;
}

function build() {
  log('Building frontend and backend (npm run build) ...');
  runNpm(['run', 'build'], { cwd: ROOT });
}

async function copyApp(outDir, version) {
  const backendSrc = path.join(ROOT, 'packages', 'backend');
  const backendDest = path.join(outDir, 'app', 'backend');
  const distSrc = path.join(backendSrc, 'dist');
  if (!existsSync(path.join(distSrc, 'index.js'))) throw new Error('packages/backend/dist/index.js is missing. Build without --skip-build.');
  const frontendDist = path.join(ROOT, 'packages', 'frontend', 'dist');
  if (!existsSync(path.join(frontendDist, 'index.html'))) throw new Error('packages/frontend/dist/index.html is missing. Build without --skip-build.');
  await cp(distSrc, path.join(backendDest, 'dist'), { recursive: true, filter: (src) => !src.endsWith('.map') });
  await cp(path.join(backendSrc, 'drizzle'), path.join(backendDest, 'drizzle'), { recursive: true });
  // slim package.json: readVersion() reads the version, "type" makes dist/ ESM
  const backendPackage = await readJson(path.join(backendSrc, 'package.json'));
  await writeFile(
    path.join(backendDest, 'package.json'),
    `${JSON.stringify({ name: backendPackage.name, version, private: true, type: 'module', main: 'dist/index.js' }, null, 2)}\n`,
  );
  await cp(frontendDist, path.join(outDir, 'app', 'frontend', 'dist'), { recursive: true });
}

async function copyPlatformFiles(outDir, target) {
  const common = path.join(ROOT, 'installer', 'common');
  const tools = path.join(outDir, 'tools');
  await mkdir(tools, { recursive: true });
  await cp(path.join(common, 'setup-config.mjs'), path.join(tools, 'setup-config.mjs'));
  await cp(path.join(common, 'lan.mjs'), path.join(tools, 'lan.mjs'));
  await cp(path.join(common, 'worldfoundry.env.template'), path.join(tools, 'worldfoundry.env.template'));
  await cp(path.join(ROOT, 'scripts', 'lib', 'config.mjs'), path.join(tools, 'config.mjs'));
  if (target.platform === 'win32') {
    const dir = path.join(ROOT, 'installer', 'windows');
    await cp(path.join(dir, 'worldfoundry-service.xml'), path.join(outDir, 'worldfoundry-service.xml'));
    await cp(path.join(dir, 'start-portable.cmd'), path.join(outDir, 'start-portable.cmd'));
    // Batch files need CRLF, even if the ZIP is built on Linux
    const reset = (await readFile(path.join(dir, 'reset-password.cmd'), 'utf8')).replace(/\r?\n/g, '\r\n');
    await writeFile(path.join(outDir, 'reset-password.cmd'), reset);
    await cp(path.join(dir, 'README.txt'), path.join(outDir, 'README.txt'));
    await cp(path.join(dir, 'worldfoundry-updater-service.xml'), path.join(outDir, 'worldfoundry-updater-service.xml'));
    const winsw = await downloadVerified({
      url: WINSW.url,
      allowedHosts: WINSW.allowedHosts,
      destination: path.join(CACHE, WINSW.fileName),
      sha256: WINSW.sha256,
      label: `WinSW ${WINSW.version}`,
    });
    await cp(winsw, path.join(outDir, 'worldfoundry-service.exe'));
    await cp(winsw, path.join(outDir, 'worldfoundry-updater-service.exe'));
    await cp(path.join(dir, 'WinSW-LICENSE.txt'), path.join(outDir, 'tools', 'LICENSE-WinSW.txt'));
  } else {
    const dir = path.join(ROOT, 'installer', 'linux');
    for (const name of ['install.sh', 'uninstall.sh', 'worldfoundry', 'worldfoundry.service', 'worldfoundry-update.service', 'worldfoundry-update.path', 'README.txt']) {
      // Shell scripts must have LF line endings, even if the checkout on Windows produced CRLF
      const text = (await readFile(path.join(dir, name), 'utf8')).replace(/\r\n/g, '\n');
      await writeFile(path.join(outDir, name), name === 'worldfoundry.service' ? unitForTarget(text, target) : text);
    }
  }
}

// Startup check: only possible if the target system matches the build machine
function smokeTest(outDir, target) {
  const nodeBinary = path.join(outDir, 'node', target.nodeBinaryName);
  const backend = path.join(outDir, 'app', 'backend');
  const code = `
    import { pathToFileURL } from 'node:url';
    import path from 'node:path';
    const { createClient } = await import('@libsql/client');
    const client = createClient({ url: ':memory:' });
    const row = (await client.execute('select sqlite_version() as v')).rows[0];
    client.close();
    await import(pathToFileURL(path.resolve('dist', 'app.js')).href);
    console.log('libsql ok, SQLite ' + row.v);
  `;
  const result = spawnSync(nodeBinary, ['--input-type=module', '-e', code], { cwd: backend, encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(`Startup check with the bundled Node failed:\n${describeSpawnFailure(result)}`);
  }
  log(`  Startup check (bundled Node ${path.basename(nodeBinary)}): ${result.stdout.trim()}`);
}

async function writeArchive(outDir, archivePath, prefix, target) {
  const entries = [{ path: prefix, type: 'dir', mode: 0o755 }];
  for (const item of await walk(outDir)) {
    entries.push({ path: `${prefix}/${item.rel}`, type: item.type, mode: modeFor(item.rel, item.type), file: item.file });
  }
  const mtime = Number(process.env.SOURCE_DATE_EPOCH ?? Math.floor(Date.now() / 1000));
  if (target.archiveKind === 'zip') await writeZip(archivePath, entries);
  else await writeTarGz(archivePath, entries, mtime);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    log(HELP);
    return;
  }
  const target = getTarget(options.target);
  const releaseDir = options.outDir === null ? RELEASE : path.resolve(options.outDir);
  const outDir = path.join(releaseDir, target.name);
  const backendPackage = await readJson(path.join(ROOT, 'packages', 'backend', 'package.json'));
  const version = options.versionOverride ?? backendPackage.version;
  const prefix = releaseBaseName(version, target);

  log(`Package ${prefix} (build machine: ${os.platform()}-${os.arch()})`);
  if (!options.skipBuild) build();

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  log('Copying the application ...');
  await copyApp(outDir, version);

  const stagingDir = path.join(releaseDir, '.stage', target.name);
  const nodeModules = await stageProduction({ root: ROOT, stagingDir, target, log });
  await cp(nodeModules, path.join(outDir, 'app', 'node_modules'), { recursive: true });
  await rm(stagingDir, { recursive: true, force: true });

  const nativeFile = path.join(outDir, 'app', 'node_modules', ...target.libsql.split('/'), 'index.node');
  const machine = await readMachineFromFile(nativeFile);
  if (!machineMatches(machine, target.machine)) {
    throw new Error(`${target.libsql}/index.node does not have the architecture of ${target.name} (found: ${JSON.stringify(machine)}).`);
  }
  log(`  native library ${target.libsql}: ${machine.format.toUpperCase()} header matches ${target.name}`);

  log('Downloading Node.js ...');
  const node = await resolveNode(target, options.nodeVersion);
  const nodeLicense = await extractNode(node, target, outDir);
  const nodeMachine = await readMachineFromFile(path.join(outDir, 'node', target.nodeBinaryName));
  if (!machineMatches(nodeMachine, target.machine)) {
    throw new Error(`The Node executable does not have the architecture of ${target.name} (found: ${JSON.stringify(nodeMachine)}).`);
  }
  log(`  Node executable: ${nodeMachine.format.toUpperCase()} header matches ${target.name}`);

  log('Copying installation files ...');
  await copyPlatformFiles(outDir, target);
  await writeUpdateFiles({ root: ROOT, outDir, options, log });

  // The GPL-3.0 text of the repository is shipped as LICENSE.txt; without it the package cannot be built
  const licenseSource = path.join(ROOT, 'LICENSE');
  if (!existsSync(licenseSource)) throw new Error('LICENSE is missing in the repository root.');
  await writeFile(path.join(outDir, 'LICENSE.txt'), await readFile(licenseSource));
  const extras = [{ name: 'Node.js', version: node.version, license: 'MIT and others (see text)', text: nodeLicense.trim() }];
  if (target.platform === 'win32') {
    extras.push({ name: 'WinSW', version: WINSW.version, license: WINSW.license, text: (await readFile(path.join(ROOT, 'installer', 'windows', 'WinSW-LICENSE.txt'), 'utf8')).trim() });
  }
  const packages = mergePackages(await collectPackages(path.join(outDir, 'app', 'node_modules')), await collectFrontendPackages(ROOT));
  await writeFile(path.join(outDir, 'THIRD-PARTY-NOTICES.txt'), formatNotices({ productName: 'WorldFoundry', packages, extras }));

  await writeFile(path.join(outDir, 'VERSION'), `${version}\n`);
  await writeFile(
    path.join(outDir, 'version.json'),
    `${JSON.stringify({ name: 'WorldFoundry', version, target: target.name, node: node.version, ...(target.platform === 'win32' ? { winsw: WINSW.version } : {}), builtAt: new Date().toISOString() }, null, 2)}\n`,
  );

  if (!options.skipSmoke && hostTargetName() === target.name) smokeTest(outDir, target);
  else log(`  Startup check skipped (target ${target.name} ≠ build machine)`);

  const summary = [];
  if (!options.noArchive) {
    const archivePath = path.join(releaseDir, `${prefix}.${target.archiveKind}`);
    log(`Writing ${path.basename(archivePath)} ...`);
    await rm(archivePath, { force: true });
    await writeArchive(outDir, archivePath, prefix, target);
    const hash = await sha256File(archivePath);
    await writeFile(`${archivePath}.sha256`, `${hash}  ${path.basename(archivePath)}\n`);
    summary.push(`${archivePath}  ${((await stat(archivePath)).size / 1048576).toFixed(1)} MB  sha256=${hash}`);
  }
  log(`\nDone: ${outDir}`);
  for (const line of summary) log(line);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
