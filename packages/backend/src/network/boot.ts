import { msg, type MessageRef, type Msg } from '../messages.js';
import { isWildcardHost } from '../lib/network.js';

const errorCode = (error: unknown): string | undefined => (typeof error === 'object' && error !== null ? ((error as { code?: unknown }).code as string | undefined) : undefined);

export interface ListenPlan {
  host: string;
  port: number;
  // the config-file value: where to fall back to when the stored port is taken
  defaultPort: number;
}

export interface ListenResult {
  host: string;
  port: number;
  warnings: string[];
  // key and params per warning, same order
  warningRefs: MessageRef[];
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

// Binds like the plan says; when that is impossible the application must still come up (a lockout would need a
// visit to the machine): an address that does not exist falls back to all adapters, a port that is taken falls back
// to the port of the config file. The reasons are returned as warnings for the log and the UI.
export async function listenWithFallback(listen: (options: { host: string; port: number }) => Promise<unknown>, plan: ListenPlan): Promise<ListenResult> {
  let { host, port } = plan;
  const warnings: Msg[] = [];
  let hostFell = false;
  let portFell = false;
  for (;;) {
    try {
      await listen({ host, port });
      return { host, port, warnings: warnings.map((w) => w.text), warningRefs: warnings.map((w) => w.ref) };
    } catch (error) {
      const reason = errorCode(error);
      const addressMissing = reason === 'EADDRNOTAVAIL' || reason === 'EINVAL' || reason === 'ENOTFOUND';
      if (addressMissing && !hostFell && !isWildcardHost(host) && !LOOPBACK.has(host)) {
        warnings.push(msg('NETWORK_ADDRESS_MISSING', { host }));
        host = '0.0.0.0';
        hostFell = true;
        continue;
      }
      if (reason === 'EADDRINUSE' && !portFell && port !== plan.defaultPort) {
        warnings.push(msg('NETWORK_PORT_FALLBACK', { port, defaultPort: plan.defaultPort }));
        port = plan.defaultPort;
        portFell = true;
        continue;
      }
      throw error;
    }
  }
}
