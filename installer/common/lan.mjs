// Which addresses of this computer should be given to other devices on the home network?
//
// Same logic as packages/backend/src/lib/network.ts (same test cases: scripts/test/lan-cases.json):
// IPv4 only, no loopback and link-local addresses (169.254/16), private ranges (192.168/16, 10/8, 172.16/12)
// first, virtual adapters and VPNs (WSL, Hyper-V, Docker, VirtualBox, VMware, Tailscale, ZeroTier, ...)
// separately as "VPN/virtual".
//
//   node lan.mjs [--port 3000 | --data-dir <Ordner> | --config <Datei>] [--text | --json | --probe]
//   --probe  prints the address under which the application answers a health check (e.g. http://127.0.0.1:3000)
//
// The port comes from --port, otherwise from <data-dir>/network.json (the port WorldFoundry really listens on,
// even if it was changed in the web interface), otherwise from PORT in the configuration file, otherwise 3000.
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';

const VIRTUAL_NAME =
  /vethernet|wsl|hyper-?v|docker|^br-|^veth|virbr|virtualbox|vboxnet|vmware|vmnet|tailscale|zerotier|^zt|^wg\d|wireguard|^tun\d|^tap\d|^utun|^ppp\d|vpn|hamachi|loopback|npcap/i;

export const isVirtualInterface = (name) => VIRTUAL_NAME.test(name);

function octets(address) {
  if (!net.isIPv4(address)) return null;
  return address.split('.').map(Number);
}

export function isPrivateIPv4(address) {
  const o = octets(address);
  if (o === null) return false;
  return o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168);
}

export function isLinkLocalIPv4(address) {
  const o = octets(address);
  return o !== null && o[0] === 169 && o[1] === 254;
}

function rank(entry) {
  const o = octets(entry.address);
  if (o === null) return 9;
  if (o[0] === 192 && o[1] === 168) return 0;
  if (o[0] === 10) return 1;
  if (entry.private) return 2;
  return 3;
}

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byRank = (a, b) => rank(a) - rank(b) || compare(a.interfaceName, b.interfaceName) || compare(a.address, b.address);

export function detectAddresses(interfaces = os.networkInterfaces()) {
  const lan = [];
  const virtual = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      const isIPv4 = entry.family === 'IPv4' || entry.family === 4;
      if (!isIPv4 || entry.internal || entry.address === '0.0.0.0' || isLinkLocalIPv4(entry.address)) continue;
      (isVirtualInterface(name) ? virtual : lan).push({ address: entry.address, interfaceName: name, private: isPrivateIPv4(entry.address) });
    }
  }
  return { lan: lan.sort(byRank), virtual: virtual.sort(byRank) };
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function resolvePort({ port, dataDir, config } = {}) {
  if (port !== undefined) return Number(port);
  if (dataDir !== undefined) {
    const info = readJson(path.join(dataDir, 'network.json'));
    if (info !== null && Number.isInteger(info.port)) return info.port;
  }
  if (config !== undefined && existsSync(config)) {
    try {
      const value = Number(parseEnv(readFileSync(config, 'utf8')).PORT);
      if (Number.isInteger(value) && value >= 1 && value <= 65535) return value;
    } catch {
      // unreadable configuration: default
    }
  }
  return 3000;
}

const ascii = (text) => text.replace(/[^\x20-\x7e]/g, '?');

// Text for installer pages and the credentials file
export function formatText({ lan, virtual }, port, hostname) {
  const lines = [];
  if (lan.length === 0) lines.push('   (no network address found - is the computer connected to the network?)');
  for (const entry of lan) lines.push(`   http://${entry.address}:${port}`);
  lines.push(`   http://${hostname}:${port}   (host name)`);
  if (virtual.length > 0) {
    lines.push('', 'VPN/virtual adapters (reachable from these networks only):');
    for (const entry of virtual) lines.push(`   http://${entry.address}:${port}   [${ascii(entry.interfaceName)}]`);
  }
  return lines.join('\r\n');
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { values } = parseArgs({
    options: { port: { type: 'string' }, 'data-dir': { type: 'string' }, config: { type: 'string' }, text: { type: 'boolean', default: false }, json: { type: 'boolean', default: false }, probe: { type: 'boolean', default: false } },
    strict: true,
  });
  if (values.probe) {
    // same selection as the updater health check (network.json, otherwise the configuration)
    const { healthTarget, readConfig } = await import('./updater.mjs');
    const configFile = values.config ?? '';
    const config = readConfig(configFile);
    if (values['data-dir'] !== undefined && config.DATA_DIR === undefined) config.DATA_DIR = values['data-dir'];
    const target = healthTarget(config, configFile === '' ? path.join(values['data-dir'] ?? '.', 'x.env') : configFile);
    console.log(`http://${target.host}:${target.port}`);
    process.exit(0);
  }
  const port = resolvePort({ port: values.port, dataDir: values['data-dir'], config: values.config });
  const detected = detectAddresses();
  const hostname = os.hostname();
  if (values.json) {
    const withUrl = (entry) => ({ ...entry, url: `http://${entry.address}:${port}` });
    console.log(JSON.stringify({ port, hostname, lan: detected.lan.map(withUrl), virtual: detected.virtual.map(withUrl) }));
  } else if (values.text) {
    process.stdout.write(`${formatText(detected, port, hostname)}\r\n`);
  } else {
    for (const entry of detected.lan) console.log(`http://${entry.address}:${port}`);
    console.log(`http://${hostname}:${port}`);
  }
}
