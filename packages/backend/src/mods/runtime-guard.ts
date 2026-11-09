import { AppError } from '../http/errors.js';

export interface ServerRuntimeGuard {
  isRunning(serverId: string): boolean;
}

export const noRunningServers: ServerRuntimeGuard = { isRunning: () => false };

export function assertNotRunning(guard: ServerRuntimeGuard, serverId: string): void {
  if (guard.isRunning(serverId)) {
    throw new AppError(
      409,
      'SERVER_RUNNING',
      'The server is running. Please stop it first before changing mods.',
    );
  }
}
