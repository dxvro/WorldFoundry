import type { GameId } from '@worldfoundry/backend/contract';
import { Bone, Factory, Pickaxe, Skull, type LucideIcon } from 'lucide-react';

// How a game looks in the interface. The icons are generic symbols and the colours are WorldFoundry's own: no logo,
// cover or other artwork of any game is used. The short name is also what is shown while the list of games has not
// arrived yet. The hue is an OKLCH hue angle; GameTile turns it into a tile colour that reads on the dark theme.
export const GAME_LOOK: Record<GameId, { icon: LucideIcon; shortName: string; hue: number }> = {
  minecraft: { icon: Pickaxe, shortName: 'Minecraft', hue: 145 },
  zomboid: { icon: Skull, shortName: 'Project Zomboid', hue: 25 },
  satisfactory: { icon: Factory, shortName: 'Satisfactory', hue: 65 },
  ark: { icon: Bone, shortName: 'ARK', hue: 290 },
};

export const GAME_ORDER: readonly GameId[] = ['minecraft', 'zomboid', 'satisfactory', 'ark'];

export const isGameId = (value: string): value is GameId => (GAME_ORDER as readonly string[]).includes(value);
