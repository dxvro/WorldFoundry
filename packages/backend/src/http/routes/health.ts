import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { HealthInfo } from '../../contract.js';
import { AppError } from '../errors.js';
import type { AppContext } from '../../app.js';

export function registerHealthRoutes(app: FastifyInstance, { db, version, services }: AppContext): void {
  app.get('/api/health', async (request): Promise<HealthInfo> => {
    try {
      await db.run(sql`select 1`);
    } catch (error) {
      app.log.error({ err: error }, 'Database health check failed');
      throw new AppError(503, 'DATABASE_UNAVAILABLE', 'The database is not reachable.');
    }
    // without a valid login only the bare minimum is disclosed
    if (!services.auth.isAuthenticated(request)) return { status: 'ok', database: 'ok' };
    return {
      status: 'ok',
      version,
      uptimeSeconds: Math.round(process.uptime()),
      database: 'ok',
      lanUrls: services.network.urls(),
    };
  });
}
