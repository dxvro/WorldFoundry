import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildApp } from './app.js';
import { ensureInitialPassword, removeInitialPasswordFile } from './auth/first-start.js';
import { ConfigError, loadConfig, loadDotEnv } from './config/env.js';
import { openDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { describeAccess, isWildcardHost } from './lib/network.js';
import { listenWithFallback } from './network/boot.js';
import { effectiveNetwork, readStoredNetwork } from './network/settings.js';
import { SettingsStore } from './settings/store.js';
import { readVersion } from './lib/version.js';
import { ModrinthClient } from './modrinth/client.js';
import { realSpawner } from './process/spawner.js';

const SHUTDOWN_EXTRA_WAIT_MS = 15_000;

function isAddrInUse(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'EADDRINUSE';
}

async function main(): Promise<void> {
  const configFile = loadDotEnv();
  const envConfig = loadConfig();
  const config = { ...envConfig };

  await mkdir(config.dataDir, { recursive: true });
  await mkdir(config.serversDir, { recursive: true });

  const handle = await openDb(path.join(config.dataDir, 'worldfoundry.db'));
  await runMigrations(handle.db);

  // Network settings chosen in the web UI replace HOST, PORT and ALLOWED_HOSTS of the config file
  const networkDefaults = { host: envConfig.host, port: envConfig.port, allowedHosts: envConfig.allowedHosts };
  const network = effectiveNetwork(networkDefaults, await readStoredNetwork(new SettingsStore(handle.db)));
  Object.assign(config, { host: network.host, port: network.port, allowedHosts: network.allowedHosts });

  // never without a sign-in: the first start without AUTH_TOKEN creates a password (printed below, after the address)
  const initialPassword = await ensureInitialPassword({ db: handle.db, dataDir: config.dataDir, authToken: config.authToken });

  const userAgent = config.modrinthUserAgent ?? `WorldFoundry/${readVersion()}`;
  const app = buildApp({
    db: handle.db,
    config,
    modrinth: new ModrinthClient({ userAgent }),
    spawner: realSpawner,
    network: { defaults: networkDefaults },
    // "Restart now": the normal shutdown (stops all servers cleanly), then this exit code
    restart: { exit: (code) => void shutdown('Restart', code) },
  });
  const { manager } = app.services;
  // a password set in the web interface or with reset-password replaces the initial one
  app.services.auth.onCredentialChange(() => void removeInitialPasswordFile(config.dataDir).catch(() => undefined));

  let shuttingDown = false;
  const shutdown = async (signal: string, exitCode = 0): Promise<void> => {
    if (shuttingDown) {
      app.log.warn(`${signal} received, shutdown is already in progress. Please wait so that world data is saved safely.`);
      return;
    }
    shuttingDown = true;
    app.log.info(signal === 'Restart' ? 'Restart requested, shutting down ...' : `${signal} received, shutting down ...`);
    try {
      // running servers first: the world data is the one thing that must not be lost
      await manager.shutdown(config.stopTimeoutMs + SHUTDOWN_EXTRA_WAIT_MS);
      await app.close();
    } catch (error) {
      app.log.error({ err: error }, 'Error during shutdown');
      exitCode = 1;
    } finally {
      handle.close();
    }
    process.exit(exitCode);
  };
  const signals: NodeJS.Signals[] = process.platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const signal of signals) process.on(signal, () => void shutdown(signal));
  process.on('uncaughtException', (error) => {
    app.log.error({ err: error }, 'Unhandled exception');
    void shutdown('uncaughtException', 1);
  });
  process.on('unhandledRejection', (reason) => {
    app.log.error({ err: reason }, 'Unhandled promise rejection');
  });

  let listening: Awaited<ReturnType<typeof listenWithFallback>>;
  try {
    listening = await listenWithFallback((options) => app.listen(options), { host: config.host, port: config.port, defaultPort: envConfig.port });
  } catch (error) {
    handle.close();
    if (isAddrInUse(error)) {
      const port = (error as { port?: unknown }).port;
      const used = typeof port === 'number' ? port : config.port;
      console.error(
        `Port ${used} is already in use. Set a different value in the .env file, e.g. PORT=${used + 1}, or quit the other program.`,
      );
      process.exit(1);
    }
    throw error;
  }
  app.services.network.setActive(listening.host, listening.port);
  for (const [index, warning] of listening.warnings.entries()) {
    app.log.warn(warning);
    app.services.network.addWarning(listening.warningRefs[index] === undefined ? warning : { text: warning, ref: listening.warningRefs[index] });
  }

  app.log.info(
    `Configuration: ${configFile === null ? 'no .env file, environment variables and defaults apply' : configFile}; data: ${config.dataDir}; servers: ${config.serversDir}`,
  );
  const { network: networkService } = app.services;
  app.log.info(`Web interface available at: ${describeAccess(listening.host, listening.port, networkService.detected(), networkService.hostname)}`);
  if (initialPassword !== null) {
    // on the console and not through the logger: a password does not belong into a log file or a log collector
    console.log(`\n  First start: sign in with this password and set your own under System > Password.\n\n      ${initialPassword.password}\n\n  It is also in ${initialPassword.file}\n`);
  }
  // installers and the updater read the address the application really listens on from here (the port can be changed in the UI)
  await writeNetworkInfo(config.dataDir, listening.host, listening.port).catch((error: unknown) => app.log.warn({ err: error }, 'network.json could not be written'));
}

// {"host":"0.0.0.0","port":3000,"probeHost":"127.0.0.1"}: probeHost is where a health check reaches the application
async function writeNetworkInfo(dataDir: string, host: string, port: number): Promise<void> {
  const file = path.join(dataDir, 'network.json');
  const probeHost = isWildcardHost(host) ? '127.0.0.1' : host;
  await writeFile(`${file}.tmp`, `${JSON.stringify({ host, port, probeHost, pid: process.pid })}
`, 'utf8');
  await rename(`${file}.tmp`, file);
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(error.message);
  } else {
    console.error('Start failed:', error);
  }
  process.exit(1);
});
