import type { ServerView } from '../lib/types';

export const ARK_MAPS: Record<string, string> = {
  TheIsland: 'The Island',
  TheCenter: 'The Center',
  ScorchedEarth_P: 'Scorched Earth',
  Ragnarok: 'Ragnarok',
  Aberration_P: 'Aberration',
  Extinction: 'Extinction',
  Valguero_P: 'Valguero',
  Genesis: 'Genesis: Part 1',
  CrystalIsles: 'Crystal Isles',
  Gen2: 'Genesis: Part 2',
  LostIsland: 'Lost Island',
  Fjordur: 'Fjordur',
};

export interface ArkSettings {
  map: string;
  maxPlayers: number;
  peerPort: number;
  queryPort: number;
  rconPort: number;
  adminPassword: string;
}

export function arkSettings(server: Pick<ServerView, 'game' | 'gameSettings'>): ArkSettings | null {
  if (server.game !== 'ark') return null;
  try {
    const value = JSON.parse(server.gameSettings) as Partial<ArkSettings>;
    if (typeof value.map !== 'string' || typeof value.rconPort !== 'number' || typeof value.queryPort !== 'number' || typeof value.peerPort !== 'number' || typeof value.adminPassword !== 'string') return null;
    return value as ArkSettings;
  } catch {
    return null;
  }
}
