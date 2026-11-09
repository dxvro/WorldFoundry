import net from 'node:net';
import os from 'node:os';

// Which IPv4 addresses of this machine are worth showing to people on the home network.
// The same rules (and the same test cases, scripts/test/lan-cases.json) live in installer/common/lan.mjs for the installers.

export interface DetectedAddress {
  address: string;
  interfaceName: string;
  // 10/8, 172.16/12 or 192.168/16
  private: boolean;
}

export interface DetectedAddresses {
  // physical adapters, private ranges first
  lan: DetectedAddress[];
  // VPN and virtual adapters (WSL, Hyper-V, Docker, VirtualBox, VMware, Tailscale, ...): shown separately, never dropped silently
  virtual: DetectedAddress[];
}

export type Interfaces = NodeJS.Dict<os.NetworkInterfaceInfo[]>;

// Interface names of virtual switches, containers, hypervisors and VPN tunnels
const VIRTUAL_NAME =
  /vethernet|wsl|hyper-?v|docker|^br-|^veth|virbr|virtualbox|vboxnet|vmware|vmnet|tailscale|zerotier|^zt|^wg\d|wireguard|^tun\d|^tap\d|^utun|^ppp\d|vpn|hamachi|loopback|npcap/i;

export const isVirtualInterface = (name: string): boolean => VIRTUAL_NAME.test(name);

function octets(address: string): [number, number, number, number] | null {
  if (net.isIPv4(address) === false) return null;
  const parts = address.split('.').map(Number);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 0];
}

export function isPrivateIPv4(address: string): boolean {
  const o = octets(address);
  if (o === null) return false;
  return o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168);
}

export function isLinkLocalIPv4(address: string): boolean {
  const o = octets(address);
  return o !== null && o[0] === 169 && o[1] === 254;
}

// family is a string in current Node, but older versions reported the number 4
const isIPv4 = (entry: os.NetworkInterfaceInfo): boolean => entry.family === 'IPv4' || (entry.family as string | number) === 4;

// 192.168 first (typical home network), then 10/8, then 172.16/12, then everything else
function rank(entry: DetectedAddress): number {
  const o = octets(entry.address);
  if (o === null) return 9;
  if (o[0] === 192 && o[1] === 168) return 0;
  if (o[0] === 10) return 1;
  if (entry.private) return 2;
  return 3;
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byRank = (a: DetectedAddress, b: DetectedAddress): number => rank(a) - rank(b) || compare(a.interfaceName, b.interfaceName) || compare(a.address, b.address);

export function detectAddresses(interfaces: Interfaces = os.networkInterfaces()): DetectedAddresses {
  const lan: DetectedAddress[] = [];
  const virtual: DetectedAddress[] = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (!isIPv4(entry) || entry.internal || entry.address === '0.0.0.0' || isLinkLocalIPv4(entry.address)) continue;
      const found: DetectedAddress = { address: entry.address, interfaceName: name, private: isPrivateIPv4(entry.address) };
      (isVirtualInterface(name) ? virtual : lan).push(found);
    }
  }
  return { lan: lan.sort(byRank), virtual: virtual.sort(byRank) };
}

// Every IPv4 address that is assigned to this machine right now (including loopback, virtual adapters and link-local ones)
export function localIPv4Addresses(interfaces: Interfaces = os.networkInterfaces()): string[] {
  const addresses = new Set<string>();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) if (isIPv4(entry)) addresses.add(entry.address);
  }
  return [...addresses];
}

export const isWildcardHost = (host: string): boolean => host === '0.0.0.0' || host === '::' || host === '';

export const urlFor = (host: string, port: number): string => `http://${net.isIPv6(host) ? `[${host}]` : host}:${port}`;

// The addresses people can type into a browser: all LAN adapters for a wildcard bind, only the one address for a
// specific IP, only this PC for loopback.
export function accessUrls(host: string, port: number, detected: DetectedAddresses): string[] {
  if (isWildcardHost(host)) return detected.lan.map((entry) => urlFor(entry.address, port));
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1') return [urlFor('127.0.0.1', port), `http://localhost:${port}`];
  return [urlFor(host, port)];
}

// Kept for the health route and the start log: the URLs of the physical adapters
export function getLanUrls(port: number, interfaces: Interfaces = os.networkInterfaces()): string[] {
  return detectAddresses(interfaces).lan.map((entry) => urlFor(entry.address, port));
}

// Text for the start log: "http://192.168.1.20:3000 (Host name: http://pc:3000; VPN/virtual: http://100.64.0.1:3000 [Tailscale])"
export function describeAccess(host: string, port: number, detected: DetectedAddresses, hostname: string): string {
  const urls = accessUrls(host, port, detected);
  const main = urls.length > 0 ? urls.join(', ') : '(no LAN address found)';
  const extras: string[] = [];
  if (isWildcardHost(host)) extras.push(`Host name: http://${hostname}:${port}`);
  else if (host === '127.0.0.1') extras.push('this machine only');
  if (isWildcardHost(host) && detected.virtual.length > 0) {
    extras.push(`VPN/virtual: ${detected.virtual.map((entry) => `${urlFor(entry.address, port)} [${entry.interfaceName}]`).join(', ')}`);
  }
  return extras.length > 0 ? `${main} (${extras.join('; ')})` : main;
}
