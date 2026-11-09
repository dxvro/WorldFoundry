import Fastify, { type FastifyInstance } from 'fastify';
import type { AppConfig } from './config/env.js';
import type { Db } from './db/client.js';
import { registerAuth } from './http/auth.js';
import { errorHandler, notFoundHandler } from './http/errors.js';
import { registerFrontend } from './http/frontend.js';
import { registerHostGuard } from './http/host.js';
import { registerOriginGuard } from './http/origin.js';
import { registerBackupRoutes } from './http/routes/backups.js';
import { registerHealthRoutes } from './http/routes/health.js';
import { registerJavaRoutes } from './http/routes/java.js';
import { registerModRoutes } from './http/routes/mods.js';
import { registerNetworkRoutes } from './http/routes/network.js';
import { registerPlayerRoutes } from './http/routes/players.js';
import { registerServerRoutes } from './http/routes/servers.js';
import { registerSystemRoutes } from './http/routes/system.js';
import { registerUpdateRoutes } from './http/routes/update.js';
import { registerWorldIoRoutes } from './http/routes/worldio.js';
import { registerWebSocketRoutes } from './http/ws.js';
import { readVersion } from './lib/version.js';
import { createServices, type ServiceOptions, type Services } from './services.js';

declare module 'fastify' {
  interface FastifyInstance {
    services: Services;
  }
}

export interface AppContext {
  db: Db;
  config: AppConfig;
  version: string;
  services: Services;
}

export type BuildAppOptions = Omit<ServiceOptions, 'logger'>;

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const { db, config } = options;
  const app = Fastify({
    logger: { level: config.logLevel },
    forceCloseConnections: true,
    // A world upload of 50 GB or more runs for hours: neither the whole request (Node's default is 5 minutes, Fastify's
    // 0) nor an idle-looking socket may be cut off. Pinned here so a changed default cannot silently break big imports.
    requestTimeout: 0,
    connectionTimeout: 0,
  });
  const services = createServices({ ...options, logger: app.log });
  const context: AppContext = { db, config, version: readVersion(), services };

  // clients send POSTs without a body but with Content-Type: application/json; that must not be a 400
  const parseJson = app.getDefaultJsonParser('error', 'error');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    if (typeof body !== 'string' || body.trim() === '') {
      done(null, undefined);
      return;
    }
    parseJson(request, body, done);
  });
  // Any other Content-Type (HTTP clients such as PowerShell's Invoke-RestMethod send a bodiless POST as
  // application/x-www-form-urlencoded) is fine as long as the body is empty; a real body of another type is a 415.
  // The built-in text/plain parser is dropped so that it ends up here as well. The raw import upload brings its own
  // parser in its own scope.
  app.removeContentTypeParser('text/plain');
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => {
    if (Buffer.isBuffer(body) && body.length === 0) {
      done(null, undefined);
      return;
    }
    done(Object.assign(new Error('Unsupported Media Type'), { statusCode: 415 }));
  });

  app.decorate('services', services);
  app.setErrorHandler(errorHandler);
  const frontend = config.frontendDir === undefined ? null : registerFrontend(app, config.frontendDir);
  app.setNotFoundHandler(frontend === null ? notFoundHandler : frontend.notFound);
  registerHostGuard(app, config.allowedHosts);
  registerOriginGuard(app, config.allowedOrigins);
  registerAuth(app, services.auth);
  // a new or reset password revokes the open sockets of the old sessions; the clients reconnect with their new cookie
  services.auth.onCredentialChange(() => {
    for (const client of app.websocketServer?.clients ?? []) client.close(4401, 'Session invalid');
  });
  registerWebSocketRoutes(app, context);
  registerHealthRoutes(app, context);
  registerSystemRoutes(app, context);
  registerNetworkRoutes(app, context);
  registerUpdateRoutes(app, context);
  registerJavaRoutes(app, context);
  registerBackupRoutes(app, context);
  registerServerRoutes(app, context);
  registerPlayerRoutes(app, context);
  registerModRoutes(app, services.mods);
  registerWorldIoRoutes(app, context);

  // Boot sequence: recover whatever the last run left half done, then start the background services. The
  // autostart of servers is not awaited, so the HTTP server comes up at once.
  app.addHook('onReady', async () => {
    const recover = async (label: string, task: () => Promise<number>): Promise<void> => {
      try {
        const count = await task();
        if (count > 0) app.log.warn({ count }, label);
      } catch (error) {
        app.log.error({ err: error }, `${label} (check failed)`);
      }
    };
    await recover('Interrupted installations were marked as failed', () => services.install.recoverInterrupted());
    await recover('Incomplete Java runtimes were removed', () => services.java.cleanup());
    await recover('Interrupted backups were marked as failed', () => services.backups.recoverInterrupted());
    await services.auth.refresh();
    await recover('Leftovers of world export and import could not be cleaned up', async () => {
      await services.exports.recoverInterrupted();
      await services.imports.recoverInterrupted();
      return 0;
    });
    services.exports.start();
    services.imports.start();
    services.backupScheduler.start();
    void services.update.start().catch((error: unknown) => app.log.error({ err: error }, 'Starting the update check failed'));
    // after a deliberate restart (network settings) the servers that ran before come back once the autostart is through
    void services.autostart
      .run()
      .then(
        (report) => {
          if (report.started.length + report.failed.length > 0) app.log.info(report, 'Autostart finished');
        },
        (error: unknown) => app.log.error({ err: error }, 'Autostart failed'),
      )
      .then(() => services.restart.resumeServers())
      .catch((error: unknown) => app.log.error({ err: error }, 'Starting the servers after the restart failed'));
  });
  // safety net for embedders: closing the app never leaves a server process behind
  app.addHook('onClose', async () => {
    services.backupScheduler.stop();
    services.update.stop();
    await services.manager.shutdown(config.stopTimeoutMs + 15_000);
    await services.exports.shutdown();
    await services.imports.shutdown();
    await services.backups.shutdown();
    services.java.shutdown();
    await services.install.shutdown();
  });

  return app;
}
