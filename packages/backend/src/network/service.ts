import { eq } from 'drizzle-orm';
import net from 'node:net';
import os from 'node:os';
import type { NetworkAddress, NetworkInput, NetworkSettings, NetworkState } from '../contract.js';
import type { Db } from '../db/client.js';
import { servers } from '../db/schema.js';
import { AppError } from '../http/errors.js';
import { refOf, refsOf, textOf, textsOf, type Text } from '../messages.js';
import type { KeyedLock } from '../lib/keyed-lock.js';
import { silentLogger, type Logger } from '../lib/logger.js';
import { accessUrls, detectAddresses, isWildcardHost, localIPv4Addresses, urlFor, type DetectedAddress, type DetectedAddresses, type Interfaces } from '../lib/network.js';
import type { PortProbe } from '../process/ports.js';
import { SettingsStore } from '../settings/store.js';
import {
  effectiveNetwork,
  KEY_NETWORK,
  MAX_EXTRA_HOSTS,
  normalizeAllowedHost,
  normalizePublicAddress,
  readStoredNetwork,
  sameNetwork,
  type EffectiveNetwork,
  type NetworkDefaults,
  type StoredNetwork,
} from './settings.js';

export interface NetworkServiceOptions {
  db: Db;
  // what the process was started with (stored settings already applied)
  active: EffectiveNetwork;
  // what the config file / environment says
  defaults: NetworkDefaults;
  probePort: PortProbe;
  lock: KeyedLock;
  // service installations restart themselves, everything else has to be started by hand
  restartInfo: () => { automatic: boolean; note: Text };
  interfaces?: () => Interfaces;
  hostname?: () => string;
  logger?: Logger;
}

const toDto = (entry: DetectedAddress, port: number): NetworkAddress => ({
  address: entry.address,
  interfaceName: entry.interfaceName,
  url: urlFor(entry.address, port),
  private: entry.private,
});

export class NetworkService {
  private readonly store: SettingsStore;
  private readonly logger: Logger;
  private active: EffectiveNetwork;
  private readonly warnings: Text[] = [];

  constructor(private readonly options: NetworkServiceOptions) {
    this.store = new SettingsStore(options.db);
    this.logger = options.logger ?? silentLogger;
    this.active = { ...options.active, allowedHosts: [...options.active.allowedHosts] };
  }

  private interfaces(): Interfaces {
    return this.options.interfaces?.() ?? os.networkInterfaces();
  }

  get hostname(): string {
    return this.options.hostname?.() ?? os.hostname();
  }

  // the running process listens here (after a possible fallback at start)
  setActive(host: string, port: number): void {
    this.active = { ...this.active, host, port };
  }

  addWarning(text: Text): void {
    this.warnings.push(text);
  }

  get activePort(): number {
    return this.active.port;
  }

  get activeHost(): string {
    return this.active.host;
  }

  detected(): DetectedAddresses {
    return detectAddresses(this.interfaces());
  }

  // Access URLs of the running process (health route)
  urls(): string[] {
    return accessUrls(this.active.host, this.active.port, this.detected());
  }

  async state(): Promise<NetworkState> {
    return this.toState(await readStoredNetwork(this.store));
  }

  private toState(stored: StoredNetwork): NetworkState {
    const detected = this.detected();
    const pending = effectiveNetwork(this.options.defaults, stored);
    const hostname = this.hostname;
    const publicUrl = stored.publicAddress === undefined ? null : (normalizePublicAddress(stored.publicAddress)?.url ?? null);
    const settings: NetworkSettings = {
      bindHost: stored.bindHost ?? null,
      port: stored.port ?? null,
      allowedHosts: stored.allowedHosts ?? [],
      publicAddress: publicUrl,
    };
    const restart = this.options.restartInfo();
    return {
      hostname,
      hostnameUrl: `http://${hostname}:${this.active.port}`,
      lan: detected.lan.map((entry) => toDto(entry, this.active.port)),
      virtual: detected.virtual.map((entry) => toDto(entry, this.active.port)),
      active: { host: this.active.host, port: this.active.port, allowedHosts: this.active.allowedHosts, urls: accessUrls(this.active.host, this.active.port, detected) },
      settings,
      defaults: { host: this.options.defaults.host, port: this.options.defaults.port, allowedHosts: this.options.defaults.allowedHosts },
      pending: { host: pending.host, port: pending.port, allowedHosts: pending.allowedHosts, urls: accessUrls(pending.host, pending.port, detected) },
      publicUrl,
      restartRequired: !sameNetwork(pending, this.active),
      warnings: textsOf(this.warnings),
      warningRefs: refsOf(this.warnings),
      restart: { automatic: restart.automatic, note: textOf(restart.note), noteRef: refOf(restart.note) },
    };
  }

  // The addresses people should open after the next start (public address first, then the machine name)
  async pendingUrls(): Promise<string[]> {
    const state = await this.state();
    const urls = [...state.pending.urls];
    if (isWildcardHost(state.pending.host)) urls.push(`http://${state.hostname}:${state.pending.port}`);
    if (state.publicUrl !== null) urls.unshift(state.publicUrl);
    return [...new Set(urls)];
  }

  async save(input: NetworkInput): Promise<NetworkState> {
    return this.options.lock.run('network-settings', async () => {
      const next: StoredNetwork = { ...(await readStoredNetwork(this.store)) };
      if (input.bindHost !== undefined) {
        if (input.bindHost === null || input.bindHost.trim() === '') delete next.bindHost;
        else next.bindHost = this.validateBindHost(input.bindHost.trim());
      }
      if (input.port !== undefined) {
        if (input.port === null) delete next.port;
        else next.port = await this.validatePort(input.port);
      }
      if (input.allowedHosts !== undefined) {
        const hosts = this.validateHosts(input.allowedHosts);
        if (hosts.length === 0) delete next.allowedHosts;
        else next.allowedHosts = hosts;
      }
      if (input.publicAddress !== undefined) {
        if (input.publicAddress === null || input.publicAddress.trim() === '') delete next.publicAddress;
        else next.publicAddress = this.validatePublicAddress(input.publicAddress);
      }
      await this.store.set(KEY_NETWORK, Object.keys(next).length === 0 ? null : JSON.stringify(next));
      this.logger.info({}, 'Network settings saved (effective after the restart)');
      return this.toState(next);
    });
  }

  private validateBindHost(value: string): string {
    if (value === '0.0.0.0' || value === '127.0.0.1') return value;
    if (!net.isIPv4(value)) {
      throw new AppError(422, 'NETWORK_ADDRESS_INVALID', `"${value}" is not a valid IPv4 address. Allowed are 0.0.0.0 (all adapters), 127.0.0.1 (this machine only) or an address of this machine.`, undefined, { value });
    }
    const local = localIPv4Addresses(this.interfaces());
    if (!local.includes(value)) {
      throw new AppError(
        422,
        'NETWORK_ADDRESS_UNKNOWN',
        `The address ${value} does not belong to any network adapter of this machine. With a non-existent address WorldFoundry would not be reachable.${local.length > 0 ? ` Available addresses: ${local.join(', ')}.` : ''}`,
      );
    }
    return value;
  }

  private async validatePort(value: number): Promise<number> {
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      throw new AppError(422, 'NETWORK_PORT_INVALID', 'The port must be a whole number between 1 and 65535.');
    }
    // the port this process listens on is naturally taken: by itself
    if (value === this.active.port) return value;
    const rows = await this.options.db.select({ name: servers.name }).from(servers).where(eq(servers.port, value));
    if (rows.length > 0) {
      throw new AppError(422, 'NETWORK_PORT_IN_USE', `The port ${value} is assigned to the Minecraft server "${rows[0]?.name ?? ''}". Please choose a different port for the web interface.`, undefined, { port: value, server: rows[0]?.name ?? '' });
    }
    const state = await this.options.probePort(value);
    if (state === 'in-use') {
      throw new AppError(422, 'NETWORK_PORT_IN_USE', `The port ${value} is already in use on this machine. Please choose a free port.`, undefined, { port: value });
    }
    if (state === 'denied') {
      throw new AppError(422, 'NETWORK_PORT_DENIED', `Permission is missing for port ${value} (ports below 1024 are blocked for normal user accounts). Please choose a higher port.`, undefined, { port: value });
    }
    return value;
  }

  private validateHosts(entries: string[]): string[] {
    const hosts: string[] = [];
    const invalid: string[] = [];
    for (const entry of entries) {
      if (entry.trim() === '') continue;
      const hostname = normalizeAllowedHost(entry);
      if (hostname === null) invalid.push(entry.trim());
      else if (!hosts.includes(hostname)) hosts.push(hostname);
    }
    if (invalid.length > 0) {
      throw new AppError(422, 'NETWORK_HOST_INVALID', `Invalid host name: ${invalid.map((entry) => `"${entry}"`).join(', ')}. Allowed are names like minecraft.fritz.box (without http:// and without a path).`, undefined, { hosts: invalid.join(', ') });
    }
    if (hosts.length > MAX_EXTRA_HOSTS) {
      throw new AppError(422, 'NETWORK_HOST_INVALID', `At most ${MAX_EXTRA_HOSTS} additional host names are possible.`, undefined, { max: MAX_EXTRA_HOSTS });
    }
    return hosts;
  }

  private validatePublicAddress(value: string): string {
    const parsed = normalizePublicAddress(value);
    if (parsed === null) {
      throw new AppError(422, 'NETWORK_PUBLIC_INVALID', 'The public address is invalid. Examples: minecraft.fritz.box or http://192.168.178.20:3000');
    }
    return parsed.url;
  }
}
