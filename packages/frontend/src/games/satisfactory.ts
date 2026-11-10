import type { ServerView } from '../lib/types';

export interface SatisfactorySettings {
  branch: 'public' | 'experimental';
  reliablePort: number;
}

export function satisfactorySettings(server: Pick<ServerView, 'game' | 'gameSettings'>): SatisfactorySettings | null {
  if (server.game !== 'satisfactory') return null;
  try {
    const value = JSON.parse(server.gameSettings) as Partial<SatisfactorySettings>;
    if ((value.branch !== 'public' && value.branch !== 'experimental') || typeof value.reliablePort !== 'number') return null;
    return value as SatisfactorySettings;
  } catch {
    return null;
  }
}
