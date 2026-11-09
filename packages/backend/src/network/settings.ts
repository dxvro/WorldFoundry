import net from 'node:net';
import { parseHostHeader } from '../http/host.js';
import { SettingsStore } from '../settings/store.js';

// Network settings chosen in the web UI. They override HOST, PORT and ALLOWED_HOSTS of the config file at boot;
// the config file stays the fallback for everything that is not set here.
export const KEY_NETWORK = 'network.settings';
export const MAX_EXTRA_HOSTS = 20;

export interface StoredNetwork {
  bindHost?: string;
  port?: number;
  allowedHosts?: string[];
  publicAddress?: string;
}

export interface NetworkDefaults {
  host: string;
  port: number;
  allowedHosts: string[];
}

export interface EffectiveNetwork {
  host: string;
  port: number;
  allowedHosts: string[];
}

// "minecraft.fritz.box" and ":3000"-style input become the plain lowercase host name; anything else is invalid
export function normalizeAllowedHost(entry: string): string | null {
  const text = entry.trim();
  if (text === '' || /[\s/\@?#]/.test(text)) return null;
  const hostname = parseHostHeader(text);
  return hostname === null || hostname === '' ? null : hostname;
}

export interface PublicAddress {
  url: string;
  hostname: string;
}

// "pc.fritz.box", "pc.fritz.box:3000" or "http://pc.fritz.box:3000" -> { url: "http://pc.fritz.box:3000", hostname }
export function normalizePublicAddress(input: string): PublicAddress | null {
  let text = input.trim();
  if (text === '') return null;
  let scheme = 'http';
  const match = /^(https?):\/\//i.exec(text);
  if (match?.[1] !== undefined) {
    scheme = match[1].toLowerCase();
    text = text.slice(match[0].length);
  }
  text = text.replace(/\/+$/, '');
  if (text === '' || /[\s/\@?#]/.test(text)) return null;
  const hostname = parseHostHeader(text);
  if (hostname === null || hostname === '') return null;
  const portText = /:(\d{1,5})$/.exec(text)?.[1];
  if (portText !== undefined && (Number(portText) < 1 || Number(portText) > 65535)) return null;
  const shownHost = net.isIPv6(hostname) ? `[${hostname}]` : hostname;
  return { url: `${scheme}://${shownHost}${portText === undefined ? '' : `:${portText}`}`, hostname };
}

export function sanitizeStored(value: unknown): StoredNetwork {
  if (typeof value !== 'object' || value === null) return {};
  const raw = value as Record<string, unknown>;
  const stored: StoredNetwork = {};
  if (typeof raw['bindHost'] === 'string' && raw['bindHost'] !== '') stored.bindHost = raw['bindHost'];
  if (typeof raw['port'] === 'number' && Number.isInteger(raw['port']) && raw['port'] >= 1 && raw['port'] <= 65535) stored.port = raw['port'];
  if (Array.isArray(raw['allowedHosts'])) {
    const hosts = raw['allowedHosts'].filter((entry): entry is string => typeof entry === 'string').map(normalizeAllowedHost).filter((entry): entry is string => entry !== null);
    if (hosts.length > 0) stored.allowedHosts = [...new Set(hosts)];
  }
  if (typeof raw['publicAddress'] === 'string' && normalizePublicAddress(raw['publicAddress']) !== null) stored.publicAddress = raw['publicAddress'];
  return stored;
}

export async function readStoredNetwork(store: SettingsStore): Promise<StoredNetwork> {
  return sanitizeStored(await store.getJson<unknown>(KEY_NETWORK));
}

// What the process runs with: stored values first, then the config file. The host of the public address is allowed
// automatically, because people type exactly that name into their browser.
export function effectiveNetwork(defaults: NetworkDefaults, stored: StoredNetwork): EffectiveNetwork {
  const hosts = new Set<string>([...defaults.allowedHosts, ...(stored.allowedHosts ?? [])]);
  const publicHost = stored.publicAddress === undefined ? null : (normalizePublicAddress(stored.publicAddress)?.hostname ?? null);
  if (publicHost !== null && net.isIP(publicHost) === 0 && publicHost !== 'localhost') hosts.add(publicHost);
  return { host: stored.bindHost ?? defaults.host, port: stored.port ?? defaults.port, allowedHosts: [...hosts] };
}

export const sameNetwork = (a: EffectiveNetwork, b: EffectiveNetwork): boolean =>
  a.host === b.host && a.port === b.port && a.allowedHosts.length === b.allowedHosts.length && a.allowedHosts.every((entry) => b.allowedHosts.includes(entry));
