import type { ServerView } from '../lib/types';

export interface ZomboidSettings {
  profile: string;
  branch: string;
  udpPort: number;
  adminPassword: string;
}

// The game-specific part of a Project Zomboid server; null for other games or a damaged value.
export function zomboidSettings(server: Pick<ServerView, 'game' | 'gameSettings'>): ZomboidSettings | null {
  if (server.game !== 'zomboid') return null;
  try {
    const value = JSON.parse(server.gameSettings) as Partial<ZomboidSettings>;
    if (typeof value.profile !== 'string' || typeof value.branch !== 'string' || typeof value.udpPort !== 'number' || typeof value.adminPassword !== 'string') return null;
    return value as ZomboidSettings;
  } catch {
    return null;
  }
}
