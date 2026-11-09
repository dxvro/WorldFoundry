import type { GameId } from '@worldfoundry/backend/contract';
import { Bone, Factory, Pickaxe, Skull, type LucideIcon } from 'lucide-react';

// How a game looks in the interface. The icons are generic symbols: WorldFoundry uses no logo or artwork of any game.
// The short name is also what is shown while the list of games has not arrived yet.
export const GAME_LOOK: Record<GameId, { icon: LucideIcon; shortName: string }> = {
  minecraft: { icon: Pickaxe, shortName: 'Minecraft' },
  zomboid: { icon: Skull, shortName: 'Project Zomboid' },
  satisfactory: { icon: Factory, shortName: 'Satisfactory' },
  ark: { icon: Bone, shortName: 'ARK' },
};

export const GAME_ORDER: readonly GameId[] = ['minecraft', 'zomboid', 'satisfactory', 'ark'];

export const isGameId = (value: string): value is GameId => (GAME_ORDER as readonly string[]).includes(value);
