#!/usr/bin/env node
// WorldFoundry - privileged updater (Node built-ins only, a single file).
//
// Runs as root (Linux: worldfoundry-update.service, triggered by worldfoundry-update.path) or as SYSTEM
// (Windows: service "worldfoundry-updater" with "watch"). The application itself runs unprivileged and cannot
// install itself; it can only REQUEST an update:
//
//   <update-root>/request/     writable by the application: package, SHA256SUMS.txt, SHA256SUMS.txt.sig, request.json
//   <update-root>/status.json  written by this script only, read-only for the application
//   <update-root>/work/        root/SYSTEM only: files are copied here, checked and unpacked here
//
// Chain of trust: nothing from request/ is believed. The files are copied ONCE into the protected work folder
// (no symlink, size limit, hash over the copied bytes). There the Ed25519 signature of SHA256SUMS.txt is checked
// with the keys of the INSTALLED version (tools/update-keys.json), then the SHA-256 of the package, then name,
// version (strictly newer) and target system. Only then is it installed; if the health check fails, the
// previous version is restored.
//
// Usage:
//   node updater.mjs apply              handle one request (Linux, systemd .path)
//   node updater.mjs watch              wait for requests (Windows service)
//   node updater.mjs install-job --job <file>   install from a copy (Windows, Task Scheduler)
// Options: --update-root --install-dir --config-file --platform --stage-only (only verify, install nothing)
import { spawn } from 'node:child_process';
import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { constants as fsc, existsSync, readFileSync } from 'node:fs';
import { chmod, copyFile, cp, lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile, appendFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';

export const PROTOCOL = 1;
export const SUMS_NAME = 'SHA256SUMS.txt';
export const SIG_NAME = 'SHA256SUMS.txt.sig';
export const MAX_SUMS = 64 * 1024;
export const MAX_SIG = 1024;
export const MAX_REQUEST = 8 * 1024;
export const MAX_ASSET = 600 * 1024 * 1024;
export const ASSET_PATTERN = /^worldfoundry-[0-9A-Za-z][0-9A-Za-z.+-]{0,60}-(?:setup\.exe|linux-(?:x64|arm64)\.tar\.gz)$/;
const TASK_NAME = 'WorldFoundryUpdate';

export class UpdateError extends Error {
  constructor(message, code = 'FAILED') {
    super(message);
    this.name = 'UpdateError';
    this.code = code;
  }
}

// ---- Version -------------------------------------------------------------------------------------

const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function parseSemver(text) {
  const match = SEMVER.exec(String(text).trim());
  if (match === null) return null;
  const nums = [match[1], match[2], match[3]].map(Number);
  if (nums.some((n) => !Number.isSafeInteger(n))) return null;
  const pre = match[4] === undefined ? [] : match[4].split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  return { major: nums[0], minor: nums[1], patch: nums[2], pre };
}

export function compareSemver(a, b) {
  for (const key of ['major', 'minor', 'patch']) if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  if (a.pre.length === 0) return 1;
  if (b.pre.length === 0) return -1;
  const length = Math.max(a.pre.length, b.pre.length);
  for (let i = 0; i < length; i++) {
    const l = a.pre[i];
    const r = b.pre[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    if (typeof l === 'number' && typeof r === 'number') return l < r ? -1 : 1;
    if (typeof l === 'number') return -1;
    if (typeof r === 'number') return 1;
    return l < r ? -1 : 1;
  }
  return 0;
}

export function isNewerVersion(candidate, current) {
  const a = parseSemver(candidate);
  const b = parseSemver(current);
  return a !== null && b !== null && compareSemver(a, b) > 0;
}

// ---- Signature and checksums -------------------------------------------------------------------------

export function decodeSignature(text) {
  const compact = String(text).replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return null;
  const bytes = Buffer.from(compact, 'base64');
  return bytes.length === 64 ? bytes : null;
}

export function verifySumsSignature(sums, signatureText, keys) {
  const signature = decodeSignature(signatureText);
  if (signature === null) return false;
  for (const entry of keys) {
    try {
      const key = createPublicKey(entry.publicKey);
      if (key.asymmetricKeyType === 'ed25519' && cryptoVerify(null, sums, key, signature)) return true;
    } catch {
      // an unusable key verifies nothing
    }
  }
  return false;
}

export function parseSums(text) {
  const map = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(trimmed);
    if (match === null) throw new UpdateError('The checksum file is malformed.', 'SUMS');
    const name = match[2].trim();
    const hash = match[1].toLowerCase();
    if (map.has(name) && map.get(name) !== hash) throw new UpdateError('The checksum file is contradictory.', 'SUMS');
    map.set(name, hash);
  }
  return map;
}

export function expectedAssetName(version, target) {
  if (target === 'win-x64') return `worldfoundry-${version}-setup.exe`;
  if (target === 'linux-x64' || target === 'linux-arm64') return `worldfoundry-${version}-${target}.tar.gz`;
  return null;
}

// ---- Request -----------------------------------------------------------------------------------------

export function validateRequest(raw) {
  if (typeof raw !== 'object' || raw === null) throw new UpdateError('The update request is invalid.', 'REQUEST');
  const { schema, id, version, from, assetName, requestedAt } = raw;
  if (schema !== PROTOCOL) throw new UpdateError('The update request has an unknown format.', 'REQUEST');
  if (typeof id !== 'string' || !/^[0-9A-Za-z-]{8,64}$/.test(id)) throw new UpdateError('The update request has an invalid ID.', 'REQUEST');
  if (typeof version !== 'string' || parseSemver(version) === null || version !== version.replace(/^v/, '')) {
    throw new UpdateError('The update request does not name a valid version.', 'REQUEST');
  }
  if (typeof from !== 'string' || from.length > 64) throw new UpdateError('The update request is invalid.', 'REQUEST');
  if (typeof assetName !== 'string' || !ASSET_PATTERN.test(assetName)) throw new UpdateError('The update request does not name a valid file name.', 'REQUEST');
  if (!Number.isInteger(requestedAt) || requestedAt < 0) throw new UpdateError('The update request is invalid.', 'REQUEST');
  return { id, version, from, assetName };
}

// ---- safe copying -------------------------------------------------------------------------------

// Copies exactly ONE regular file from the request folder (writable by the application) into the protected
// work folder. Symlinks are rejected, the size is limited, the hash is computed from the copied bytes.
export async function copyRegularFile(sourceDir, name, destination, maxBytes) {
  const source = path.join(sourceDir, name);
  let info;
  try {
    info = await lstat(source);
  } catch {
    throw new UpdateError(`The file "${name}" is missing from the update request.`, 'MISSING');
  }
  if (!info.isFile()) throw new UpdateError(`"${name}" is not a regular file and is rejected.`, 'NOT_REGULAR');
  const flags = fsc.O_RDONLY | (fsc.O_NOFOLLOW ?? 0);
  const input = await open(source, flags);
  const hash = createHash('sha256');
  let total = 0;
  try {
    const opened = await input.stat();
    if (!opened.isFile() || (opened.ino !== info.ino && process.platform !== 'win32')) throw new UpdateError(`"${name}" changed while it was being copied.`, 'NOT_REGULAR');
    if (opened.size > maxBytes) throw new UpdateError(`"${name}" is larger than allowed.`, 'TOO_LARGE');
    const output = await open(destination, 'wx', 0o600);
    try {
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      for (;;) {
        const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > maxBytes) throw new UpdateError(`"${name}" is larger than allowed.`, 'TOO_LARGE');
        hash.update(buffer.subarray(0, bytesRead));
        await output.write(buffer, 0, bytesRead);
      }
    } finally {
      await output.close();
    }
  } finally {
    await input.close();
  }
  return { sha256: hash.digest('hex'), size: total };
}

// ---- Paths and context ---------------------------------------------------------------------------------

export function defaultPaths(platform, scriptDir) {
  if (platform === 'win32') {
    // The folder names keep the former product name "WorldFoundry" on purpose: installed versions (and their
    // updater) use exactly these folders, and an upgrade must find the existing data. Do not rename them.
    const programData = process.env.ProgramData ?? 'C:\\ProgramData';
    return {
      updateRoot: path.join(programData, 'WorldFoundry Update'),
      installDir: path.resolve(scriptDir, '..'),
      configFile: path.join(programData, 'WorldFoundry', 'worldfoundry.env'),
    };
  }
  return { updateRoot: '/var/lib/worldfoundry-update', installDir: '/opt/worldfoundry', configFile: '/etc/worldfoundry/worldfoundry.env' };
}

export function createContext(overrides = {}) {
  const platform = overrides.platform ?? process.platform;
  const scriptDir = overrides.scriptDir ?? path.dirname(fileURLToPath(import.meta.url));
  const defaults = defaultPaths(platform, scriptDir);
  const updateRoot = overrides.updateRoot ?? defaults.updateRoot;
  return {
    platform,
    updateRoot,
    requestDir: overrides.requestDir ?? path.join(updateRoot, 'request'),
    workRoot: overrides.workRoot ?? path.join(updateRoot, 'work'),
    backupRoot: overrides.backupRoot ?? path.join(updateRoot, 'backup'),
    installDir: overrides.installDir ?? defaults.installDir,
    configFile: overrides.configFile ?? defaults.configFile,
    now: overrides.now ?? Date.now,
    sleep: overrides.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    fetch: overrides.fetch ?? globalThis.fetch,
    run: overrides.run ?? runCommand,
    healthTimeoutMs: overrides.healthTimeoutMs ?? 120_000,
    log: overrides.log ?? (() => undefined),
    stageOnly: overrides.stageOnly ?? false,
    scriptPath: overrides.scriptPath ?? fileURLToPath(import.meta.url),
  };
}

export async function writeStatus(ctx, status) {
  const body = { schema: PROTOCOL, id: status.id ?? '', state: status.state, version: status.version ?? '', from: status.from ?? '', message: status.message ?? '', updatedAt: ctx.now() };
  await mkdir(ctx.updateRoot, { recursive: true });
  const temp = path.join(ctx.updateRoot, `.status.${process.pid}.tmp`);
  await writeFile(temp, `${JSON.stringify(body)}\n`, { mode: 0o644 });
  if (process.platform !== 'win32') await chmod(temp, 0o644);
  await rename(temp, path.join(ctx.updateRoot, 'status.json'));
  ctx.log(`Status ${body.state}: ${body.message}`);
}

export function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    let output = '';
    let child;
    try {
      child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options });
    } catch (error) {
      resolve({ code: -1, output: String(error) });
      return;
    }
    const collect = (chunk) => {
      output += chunk.toString();
      if (output.length > 200_000) output = output.slice(-100_000);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.on('error', (error) => resolve({ code: -1, output: `${output}${error}` }));
    child.on('close', (code) => resolve({ code: code ?? -1, output }));
  });
}

async function readTrustedKeys(ctx) {
  const file = path.join(ctx.installDir, 'tools', 'update-keys.json');
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    const keys = Array.isArray(parsed.keys) ? parsed.keys.filter((k) => typeof k?.publicKey === 'string') : [];
    if (keys.length > 0) return keys;
  } catch {
    // reported below
  }
  throw new UpdateError('The installed version contains no update keys (tools/update-keys.json). The update will not be installed.', 'KEYS');
}

async function readInstalled(ctx) {
  try {
    const version = (await readFile(path.join(ctx.installDir, 'VERSION'), 'utf8')).trim();
    const info = JSON.parse(await readFile(path.join(ctx.installDir, 'version.json'), 'utf8'));
    if (parseSemver(version) === null || typeof info.target !== 'string') throw new Error('invalid');
    return { version, target: info.target };
  } catch {
    throw new UpdateError('The installed version could not be determined (VERSION / version.json).', 'INSTALLED');
  }
}

async function readRequestFile(ctx) {
  const info = await lstat(path.join(ctx.requestDir, 'request.json')).catch(() => null);
  if (info === null) return null;
  if (!info.isFile() || info.size > MAX_REQUEST) throw new UpdateError('The update request is invalid.', 'REQUEST');
  const handle = await open(path.join(ctx.requestDir, 'request.json'), fsc.O_RDONLY | (fsc.O_NOFOLLOW ?? 0));
  try {
    const text = await handle.readFile({ encoding: 'utf8' });
    try {
      return JSON.parse(text);
    } catch {
      throw new UpdateError('The update request is not valid JSON.', 'REQUEST');
    }
  } finally {
    await handle.close();
  }
}

async function clearRequest(ctx) {
  let names = [];
  try {
    names = await readdir(ctx.requestDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === 'request.json' || name === SUMS_NAME || name === SIG_NAME || ASSET_PATTERN.test(name) || name.startsWith('.request.json.')) {
      await rm(path.join(ctx.requestDir, name), { force: true }).catch(() => undefined);
    }
  }
}

// ---- Verify the request and take it over into the work folder ---------------------------------------------------------

export async function stageRequest(ctx) {
  let raw;
  try {
    raw = await readRequestFile(ctx);
  } catch (error) {
    // an unreadable request must not stay behind, or the trigger would fire again and again
    await clearRequest(ctx);
    throw Object.assign(error instanceof UpdateError ? error : new UpdateError('The update request is invalid.', 'REQUEST'), { statusBase: { id: 'unknown', version: '', from: '' } });
  }
  if (raw === null) return null;
  const idHint = typeof raw?.id === 'string' && /^[0-9A-Za-z-]{8,64}$/.test(raw.id) ? raw.id : 'unknown';
  const base = { id: idHint, version: typeof raw?.version === 'string' ? raw.version.slice(0, 64) : '', from: typeof raw?.from === 'string' ? raw.from.slice(0, 64) : '' };
  let workDir = null;
  const fail = async (error) => {
    await clearRequest(ctx);
    if (workDir !== null) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    throw Object.assign(error, { statusBase: base });
  };
  try {
    const request = validateRequest(raw);
    await writeStatus(ctx, { ...base, state: 'received', message: 'Update request received.' });
    const installed = await readInstalled(ctx);
    const keys = await readTrustedKeys(ctx);
    const expectedName = expectedAssetName(request.version, installed.target);
    if (expectedName === null || request.assetName !== expectedName) {
      throw new UpdateError(`The file name "${request.assetName}" does not match version ${request.version} for this system (${installed.target}).`, 'NAME');
    }
    if (!isNewerVersion(request.version, installed.version)) {
      throw new UpdateError(`Version ${request.version} is not newer than the installed version ${installed.version}.`, 'VERSION');
    }
    await writeStatus(ctx, { ...base, state: 'verifying', message: 'Checking signature and checksum …' });
    workDir = path.join(ctx.workRoot, request.id);
    await rm(workDir, { recursive: true, force: true });
    await mkdir(workDir, { recursive: true, mode: 0o700 });
    // 1. copy (read once), from then on work with our own copies only
    const sums = await copyRegularFile(ctx.requestDir, SUMS_NAME, path.join(workDir, SUMS_NAME), MAX_SUMS);
    const sig = await copyRegularFile(ctx.requestDir, SIG_NAME, path.join(workDir, SIG_NAME), MAX_SIG);
    const asset = await copyRegularFile(ctx.requestDir, request.assetName, path.join(workDir, request.assetName), MAX_ASSET);
    await clearRequest(ctx);
    // 2. signature of the checksums, 3. hash of the package
    const sumsBytes = await readFile(path.join(workDir, SUMS_NAME));
    const sigText = await readFile(path.join(workDir, SIG_NAME), 'utf8');
    if (!verifySumsSignature(sumsBytes, sigText, keys)) {
      throw new UpdateError('The signature of the release is invalid. The update was rejected for security reasons.', 'SIGNATURE');
    }
    const expected = parseSums(sumsBytes.toString('utf8')).get(request.assetName);
    if (expected === undefined) throw new UpdateError(`The signed checksums do not list "${request.assetName}".`, 'SUMS');
    if (expected !== asset.sha256) throw new UpdateError('The package does not match the signed checksum. The update was rejected.', 'HASH');
    ctx.log(`Request ${request.id} verified: ${request.assetName} (${asset.size} bytes, sums ${sums.size}, sig ${sig.size})`);
    return { request, base, installed, workDir, assetPath: path.join(workDir, request.assetName) };
  } catch (error) {
    if (error instanceof UpdateError || error?.code === 'ENOENT') await fail(error instanceof UpdateError ? error : new UpdateError('A file of the update request is missing.', 'MISSING'));
    await fail(new UpdateError('The update request could not be verified.', 'INTERNAL'));
  }
  return null;
}

// ---- Health check -----------------------------------------------------------------------------------------

export function readConfig(configFile) {
  try {
    if (!existsSync(configFile)) return {};
    return parseEnv(readFileSync(configFile, 'utf8'));
  } catch {
    return {};
  }
}

// Address under which the application answers. Port and address may have been changed in the web interface; the
// application writes the actual values to <DATA_DIR>/network.json. That file is writable by the service account
// process, so it is only used if it looks like loopback or an address of this computer (the token never goes
// to a foreign address).
export function healthTarget(config, configFile) {
  let port = Number(config.PORT ?? 3000);
  let host = config.HOST === undefined || config.HOST === '0.0.0.0' || config.HOST === '::' ? '127.0.0.1' : config.HOST;
  if (config.DATA_DIR !== undefined) {
    try {
      const info = JSON.parse(readFileSync(path.join(path.resolve(path.dirname(configFile), config.DATA_DIR), 'network.json'), 'utf8'));
      const local = new Set(['127.0.0.1']);
      for (const entries of Object.values(os.networkInterfaces())) for (const entry of entries ?? []) if (entry.family === 'IPv4' || entry.family === 4) local.add(entry.address);
      if (Number.isInteger(info.port) && info.port >= 1 && info.port <= 65535 && typeof info.probeHost === 'string' && net.isIPv4(info.probeHost) && local.has(info.probeHost)) {
        port = info.port;
        host = info.probeHost;
      }
    } catch {
      // no file or an unreadable one: values of the configuration
    }
  }
  return { host, port };
}

export async function waitForVersion(ctx, expectedVersion) {
  const config = readConfig(ctx.configFile);
  const headers = config.AUTH_TOKEN ? { Authorization: `Bearer ${config.AUTH_TOKEN}` } : {};
  const deadline = ctx.now() + ctx.healthTimeoutMs;
  let last = 'no response';
  while (ctx.now() < deadline) {
    // read again every time: the new version only writes network.json once it is listening
    const { host, port } = healthTarget(config, ctx.configFile);
    try {
      const response = await ctx.fetch(`http://${host.includes(':') ? `[${host}]` : host}:${port}/api/health`, { headers, signal: AbortSignal.timeout(5000) });
      if (response.ok) {
        const body = await response.json();
        if (body?.status === 'ok' && body?.version === expectedVersion) return { ok: true };
        last = body?.version === undefined ? 'The response names no version (sign-in?)' : `running as version ${body.version}`;
      } else {
        last = `HTTP ${response.status}`;
      }
    } catch {
      last = 'no response';
    }
    await ctx.sleep(2000);
  }
  return { ok: false, detail: last };
}

// ---- Linux -------------------------------------------------------------------------------------------------------------

async function singleChildDir(dir) {
  const entries = (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  if (entries.length !== 1) throw new UpdateError('The package does not have the expected structure.', 'PACKAGE');
  return path.join(dir, entries[0].name);
}

export async function installLinux(ctx, staged) {
  const { request, base, installed, workDir } = staged;
  const extractDir = path.join(workDir, 'extract');
  await mkdir(extractDir, { recursive: true, mode: 0o700 });
  await writeStatus(ctx, { ...base, state: 'installing', message: 'Unpacking the package …' });
  const tar = await ctx.run('tar', ['-xzf', staged.assetPath, '-C', extractDir, '--no-same-owner']);
  if (tar.code !== 0) throw new UpdateError('The package could not be unpacked.', 'PACKAGE');
  const packageDir = await singleChildDir(extractDir);
  const packageVersion = (await readFile(path.join(packageDir, 'VERSION'), 'utf8').catch(() => '')).trim();
  const packageInfo = JSON.parse(await readFile(path.join(packageDir, 'version.json'), 'utf8').catch(() => '{}'));
  if (packageVersion !== request.version || packageInfo.target !== installed.target) {
    throw new UpdateError(`The package contains version ${packageVersion || '?'} for ${packageInfo.target ?? '?'}, but ${request.version} for ${installed.target} was expected.`, 'PACKAGE');
  }
  if (ctx.stageOnly) return { stagedOnly: true, packageDir };

  await writeStatus(ctx, { ...base, state: 'installing', message: 'Backing up the previous version …' });
  const backupDir = path.join(ctx.backupRoot, 'current');
  await rm(ctx.backupRoot, { recursive: true, force: true });
  await mkdir(ctx.backupRoot, { recursive: true, mode: 0o700 });
  const copy = await ctx.run('cp', ['-a', ctx.installDir, backupDir]);
  if (copy.code !== 0) throw new UpdateError('The previous version could not be backed up. Nothing was changed.', 'BACKUP');

  await writeStatus(ctx, { ...base, state: 'installing', message: 'Installing the new version …' });
  const install = await ctx.run(path.join(packageDir, 'install.sh'), ['--upgrade'], { cwd: packageDir });
  ctx.log(`install.sh finished with ${install.code}\n${install.output.slice(-4000)}`);
  let healthy = false;
  if (install.code === 0) {
    await writeStatus(ctx, { ...base, state: 'health-check', message: 'Checking the new version …' });
    healthy = (await waitForVersion(ctx, request.version)).ok;
  }
  if (healthy) {
    await writeStatus(ctx, { ...base, state: 'done', message: `Updated to version ${request.version}.` });
    return { done: true };
  }
  return rollbackLinux(ctx, staged, backupDir, install.code === 0 ? 'The new version does not respond as expected.' : `The installation failed (code ${install.code}).`);
}

export async function rollbackLinux(ctx, staged, backupDir, reason) {
  const { base, installed } = staged;
  await writeStatus(ctx, { ...base, state: 'installing', message: `${reason} Restoring the previous version …` });
  await ctx.run('systemctl', ['stop', 'worldfoundry.service']);
  await rm(ctx.installDir, { recursive: true, force: true });
  await rm(`${ctx.installDir}.new`, { recursive: true, force: true });
  await rm(`${ctx.installDir}.old`, { recursive: true, force: true });
  const copy = await ctx.run('cp', ['-a', backupDir, ctx.installDir]);
  if (copy.code !== 0) {
    await writeStatus(ctx, { ...base, state: 'failed', message: `${reason} The restore failed as well. Please install the previous version by hand (backup: ${backupDir}).` });
    return { done: false };
  }
  for (const unit of ['worldfoundry.service', 'worldfoundry-update.service', 'worldfoundry-update.path']) {
    if (existsSync(path.join(ctx.installDir, unit))) await ctx.run('install', ['-m', '0644', '-o', 'root', '-g', 'root', path.join(ctx.installDir, unit), `/etc/systemd/system/${unit}`]);
  }
  await ctx.run('systemctl', ['daemon-reload']);
  await ctx.run('systemctl', ['start', 'worldfoundry.service']);
  const health = await waitForVersion(ctx, installed.version);
  await writeStatus(ctx, {
    ...base,
    state: health.ok ? 'rolled-back' : 'failed',
    message: health.ok
      ? `${reason} The previous version ${installed.version} is running again.`
      : `${reason} The previous version ${installed.version} was restored but does not respond. Please check "journalctl -u worldfoundry -e".`,
  });
  return { done: false };
}

// ---- Windows ---------------------------------------------------------------------------------------------------------------

export function taskXml(command, args) {
  const esc = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>WorldFoundry Update (one-time)</Description></RegistrationInfo>
  <Principals><Principal id="Author"><UserId>S-1-5-18</UserId><RunLevel>HighestAvailable</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <Enabled>true</Enabled>
    <ExecutionTimeLimit>PT2H</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author"><Exec><Command>${esc(command)}</Command><Arguments>${esc(args)}</Arguments></Exec></Actions>
</Task>
`;
}

// The service "worldfoundry-updater" must not install by itself: the installer stops and replaces it. Therefore a
// copy of node.exe and of this script is put aside and started through the Task Scheduler (outside the service).
export async function installWindows(ctx, staged) {
  const { request, base, installed, workDir } = staged;
  if (ctx.stageOnly) return { stagedOnly: true };
  const runnerDir = path.join(workDir, 'runner');
  await mkdir(runnerDir, { recursive: true, mode: 0o700 });
  const nodeCopy = path.join(runnerDir, 'node.exe');
  const scriptCopy = path.join(runnerDir, 'updater.mjs');
  await copyFile(path.join(ctx.installDir, 'node', 'node.exe'), nodeCopy);
  await copyFile(ctx.scriptPath, scriptCopy);
  // keep the existing choice: firewall rules and Start menu only if they already exist
  // (the rule name and the Start menu folder keep the former product name "WorldFoundry" for compatibility)
  const firewall = (await ctx.run(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'netsh.exe'), ['advfirewall', 'firewall', 'show', 'rule', 'name=WorldFoundry - Web'])).code === 0;
  const startmenu = existsSync(path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'WorldFoundry'));
  const job = {
    id: request.id,
    version: request.version,
    from: installed.version,
    setup: staged.assetPath,
    workDir,
    updateRoot: ctx.updateRoot,
    installDir: ctx.installDir,
    configFile: ctx.configFile,
    backupRoot: ctx.backupRoot,
    tasks: [firewall ? 'firewall' : null, startmenu ? 'startmenu' : null].filter(Boolean),
  };
  const jobFile = path.join(workDir, 'job.json');
  await writeFile(jobFile, JSON.stringify(job), { mode: 0o600 });
  const xmlFile = path.join(workDir, 'task.xml');
  await writeFile(xmlFile, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(taskXml(nodeCopy, `"${scriptCopy}" install-job --job "${jobFile}"`), 'utf16le')]));
  const schtasks = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'schtasks.exe');
  await ctx.run(schtasks, ['/Delete', '/TN', TASK_NAME, '/F']);
  const created = await ctx.run(schtasks, ['/Create', '/TN', TASK_NAME, '/XML', xmlFile, '/F']);
  if (created.code !== 0) throw new UpdateError(`The task for the installation could not be created (${created.output.trim().slice(-200)}).`, 'TASK');
  await writeStatus(ctx, { ...base, state: 'installing', message: 'Starting the installation …' });
  const started = await ctx.run(schtasks, ['/Run', '/TN', TASK_NAME]);
  if (started.code !== 0) throw new UpdateError(`The installation could not be started (${started.output.trim().slice(-200)}).`, 'TASK');
  return { handedOver: true };
}

async function mirror(ctx, from, to) {
  const robocopy = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'robocopy.exe');
  const result = await ctx.run(robocopy, [from, to, '/MIR', '/R:2', '/W:2', '/NFL', '/NDL', '/NJH', '/NJS', '/NP']);
  // 0-7 mean success (with different copy information), 8 and more an error
  return result.code >= 0 && result.code < 8;
}

// WinSW 2.x has no "refresh" (only WinSW 3 does): a service is stopped, removed with "uninstall", then we wait until it
// has disappeared from the service manager (sc query -> 1060; "marked for deletion" = 1072 passes as soon as no handle is
// open any more), registered again with "install" and the account is set. The failure actions come from the XML file on "install".
export async function reregisterWindowsService(ctx, tool, id, account) {
  const system32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  const sc = path.join(system32, 'sc.exe');
  await ctx.run(path.join(system32, 'net.exe'), ['stop', id]);
  if ((await ctx.run(sc, ['query', id])).code !== 1060) {
    if ((await ctx.run(tool, ['uninstall'])).code !== 0) await ctx.run(sc, ['delete', id]);
    for (let attempt = 0; attempt < 30; attempt++) {
      if ((await ctx.run(sc, ['query', id])).code === 1060) break;
      await ctx.sleep(1000);
    }
  }
  let installed = false;
  for (let attempt = 0; attempt < 30 && !installed; attempt++) {
    installed = (await ctx.run(tool, ['install'])).code === 0;
    if (!installed) await ctx.sleep(1000);
  }
  if (installed) installed = (await ctx.run(sc, ['config', id, 'obj=', account])).code === 0;
  if (!installed) ctx.log(`The service ${id} could not be registered again.`);
  return installed;
}

// Runs from the copy (Task Scheduler, SYSTEM): back up, run setup silently, verify, roll back if necessary.
export async function runWindowsJob(ctx, job) {
  const base = { id: job.id, version: job.version, from: job.from };
  const system32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  const serviceTool = path.join(job.installDir, 'worldfoundry-service.exe');
  const updaterTool = path.join(job.installDir, 'worldfoundry-updater-service.exe');
  const backupDir = path.join(job.backupRoot, 'current');
  try {
    await writeStatus(ctx, { ...base, state: 'installing', message: 'Backing up the previous version …' });
    await rm(job.backupRoot, { recursive: true, force: true });
    await mkdir(job.backupRoot, { recursive: true });
    if (!(await mirror(ctx, job.installDir, backupDir))) throw new UpdateError('The previous version could not be backed up. Nothing was changed.', 'BACKUP');

    await writeStatus(ctx, { ...base, state: 'installing', message: 'The installer is running …' });
    const args = ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/NOCANCEL', `/LOG=${path.join(job.updateRoot, `setup-${job.id}.log`)}`, `/TASKS=${job.tasks.join(',')}`];
    const setup = await ctx.run(job.setup, args);
    ctx.log(`setup.exe finished with ${setup.code}`);
    let healthy = false;
    if (setup.code === 0) {
      await writeStatus(ctx, { ...base, state: 'health-check', message: 'Checking the new version …' });
      healthy = (await waitForVersion({ ...ctx, configFile: job.configFile }, job.version)).ok;
    }
    if (healthy) {
      await writeStatus(ctx, { ...base, state: 'done', message: `Updated to version ${job.version}.` });
      return true;
    }
    const reason = setup.code === 0 ? 'The new version does not respond as expected.' : `The installation failed (code ${setup.code}).`;
    await writeStatus(ctx, { ...base, state: 'installing', message: `${reason} Restoring the previous version …` });
    await ctx.run(path.join(system32, 'net.exe'), ['stop', 'worldfoundry']);
    await ctx.run(path.join(system32, 'net.exe'), ['stop', 'worldfoundry-updater']);
    const restored = await mirror(ctx, backupDir, job.installDir);
    if (restored) {
      // WinSW 2.x has no "refresh": the services are registered again from the restored files
      await reregisterWindowsService(ctx, serviceTool, 'worldfoundry', 'NT SERVICE\\worldfoundry');
      await reregisterWindowsService(ctx, updaterTool, 'worldfoundry-updater', 'LocalSystem');
      await ctx.run(path.join(system32, 'net.exe'), ['start', 'worldfoundry']);
      await ctx.run(path.join(system32, 'net.exe'), ['start', 'worldfoundry-updater']);
    }
    const back = restored ? await waitForVersion({ ...ctx, configFile: job.configFile }, job.from) : { ok: false };
    await writeStatus(ctx, {
      ...base,
      state: back.ok ? 'rolled-back' : 'failed',
      message: back.ok
        ? `${reason} The previous version ${job.from} is running again.`
        : `${reason} The previous version ${job.from} could not be restored. Please run the installer of the previous version by hand.`,
    });
    return false;
  } catch (error) {
    const message = error instanceof UpdateError ? error.message : 'The update failed for an unexpected reason.';
    ctx.log(`Error: ${error instanceof Error ? error.stack : error}`);
    await writeStatus(ctx, { ...base, state: 'failed', message });
    return false;
  } finally {
    // Deleting the scheduled task may end this very process: lock and work files go first, the task last
    // (the runner's node.exe stays locked until the end; the next request clears what is left in work\)
    await rm(path.join(job.updateRoot, 'update.lock'), { force: true }).catch(() => undefined);
    await rm(job.workDir, { recursive: true, force: true }).catch(() => undefined);
    await ctx.run(path.join(system32, 'schtasks.exe'), ['/Delete', '/TN', TASK_NAME, '/F']);
  }
}

// ---- Flow -------------------------------------------------------------------------------------------------------------------

async function acquireLock(ctx) {
  const file = path.join(ctx.updateRoot, 'update.lock');
  await mkdir(ctx.updateRoot, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(file, 'wx', 0o600);
      await handle.writeFile(`${process.pid} ${ctx.now()}\n`);
      await handle.close();
      return async () => rm(file, { force: true });
    } catch {
      const age = ctx.now() - (await stat(file).catch(() => ({ mtimeMs: ctx.now() }))).mtimeMs;
      if (age < 3 * 3600_000) return null;
      await rm(file, { force: true });
    }
  }
  return null;
}

// Handle one request. Returns false if there was none.
export async function processRequest(ctx) {
  const release = await acquireLock(ctx);
  if (release === null) {
    ctx.log('Another update is already running.');
    return false;
  }
  let handedOver = false;
  try {
    // we hold the lock, so no job is using the work folder: leftovers of earlier runs go
    await rm(ctx.workRoot, { recursive: true, force: true }).catch(() => undefined);
    await mkdir(ctx.workRoot, { recursive: true, mode: 0o700 });
    const staged = await stageRequest(ctx);
    if (staged === null) return false;
    try {
      const result = ctx.platform === 'win32' ? await installWindows(ctx, staged) : await installLinux(ctx, staged);
      handedOver = result?.handedOver === true;
      if (result?.stagedOnly === true) await writeStatus(ctx, { ...staged.base, state: 'done', message: `Verification passed (verification only): ${staged.request.assetName}` });
    } catch (error) {
      const message = error instanceof UpdateError ? error.message : 'The update failed for an unexpected reason.';
      ctx.log(`Error: ${error instanceof Error ? error.stack : error}`);
      await writeStatus(ctx, { ...staged.base, state: 'failed', message });
    } finally {
      if (!handedOver) await rm(staged.workDir, { recursive: true, force: true }).catch(() => undefined);
    }
    return true;
  } catch (error) {
    const message = error instanceof UpdateError ? error.message : 'The update request could not be processed.';
    ctx.log(`Error: ${error instanceof Error ? error.stack : error}`);
    await writeStatus(ctx, { ...(error.statusBase ?? { id: 'unknown' }), state: 'failed', message });
    return true;
  } finally {
    // after a hand-over the installation job owns the lock and releases it at its end
    if (!handedOver) await release();
  }
}

async function appendLog(ctx, message) {
  const file = path.join(ctx.updateRoot, 'updater.log');
  try {
    await mkdir(ctx.updateRoot, { recursive: true });
    const size = (await stat(file).catch(() => ({ size: 0 }))).size;
    if (size > 1_000_000) await rename(file, `${file}.1`).catch(() => undefined);
    await appendFile(file, `${new Date(ctx.now()).toISOString()} ${message}\n`);
  } catch {
    // the log is a bonus
  }
}

export async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'update-root': { type: 'string' },
      'install-dir': { type: 'string' },
      'config-file': { type: 'string' },
      platform: { type: 'string' },
      job: { type: 'string' },
      'stage-only': { type: 'boolean', default: false },
    },
  });
  const command = positionals[0];
  const overrides = {
    ...(values['update-root'] === undefined ? {} : { updateRoot: path.resolve(values['update-root']) }),
    ...(values['install-dir'] === undefined ? {} : { installDir: path.resolve(values['install-dir']) }),
    ...(values['config-file'] === undefined ? {} : { configFile: path.resolve(values['config-file']) }),
    ...(values.platform === undefined ? {} : { platform: values.platform }),
    stageOnly: values['stage-only'],
  };
  const ctx = createContext(overrides);
  let chain = Promise.resolve();
  ctx.log = (message) => {
    console.log(message);
    chain = chain.then(() => appendLog(ctx, message));
  };
  if (command === 'apply') {
    if (ctx.platform !== 'win32' && !ctx.stageOnly && typeof process.getuid === 'function' && process.getuid() !== 0) {
      console.error('The updater must run as root.');
      return 2;
    }
    await processRequest(ctx);
  } else if (command === 'watch') {
    let stop = false;
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(signal, () => (stop = true));
    ctx.log(`Update service is waiting for requests in ${ctx.requestDir}`);
    while (!stop) {
      try {
        if (existsSync(path.join(ctx.requestDir, 'request.json'))) await processRequest(ctx);
      } catch (error) {
        ctx.log(`Error in the wait loop: ${error instanceof Error ? error.message : error}`);
      }
      await ctx.sleep(2000);
    }
  } else if (command === 'install-job') {
    if (values.job === undefined) {
      console.error('--job is missing.');
      return 2;
    }
    const job = JSON.parse(await readFile(path.resolve(values.job), 'utf8'));
    const jobCtx = createContext({ ...overrides, updateRoot: job.updateRoot, installDir: job.installDir, configFile: job.configFile });
    jobCtx.log = ctx.log;
    await runWindowsJob(jobCtx, job);
  } else {
    console.error('Usage: node updater.mjs apply | watch | install-job --job <file>');
    return 2;
  }
  await chain;
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.stack : error);
      process.exit(1);
    },
  );
}
