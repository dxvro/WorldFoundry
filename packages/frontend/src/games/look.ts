import type { GameId } from '@worldfoundry/backend/contract';
import { Axe, Bone, Egg, Factory, Moon, PawPrint, Pickaxe, Skull, TreePine, type LucideIcon } from 'lucide-react';

// How a game looks in the interface. The icons are generic symbols and the colours are WorldFoundry's own: no logo,
// cover or other artwork of any game is used. The short name is also what is shown while the list of games has not
// arrived yet. The hue is an OKLCH hue angle; GameTile turns it into a tile colour that reads on the dark theme.
export const GAME_LOOK: Record<GameId, { icon: LucideIcon; shortName: string; hue: number }> = {
  minecraft: { icon: Pickaxe, shortName: 'Minecraft', hue: 145 },
  zomboid: { icon: Skull, shortName: 'Project Zomboid', hue: 25 },
  satisfactory: { icon: Factory, shortName: 'Satisfactory', hue: 65 },
  ark: { icon: Bone, shortName: 'ARK', hue: 290 },
  asa: { icon: Egg, shortName: 'ARK: Ascended', hue: 320 },
  valheim: { icon: Axe, shortName: 'Valheim', hue: 235 },
  sevendays: { icon: Moon, shortName: '7 Days to Die', hue: 355 },
  palworld: { icon: PawPrint, shortName: 'Palworld', hue: 190 },
  terraria: { icon: TreePine, shortName: 'Terraria', hue: 110 },
};

export const GAME_ORDER: readonly GameId[] = ['minecraft', 'zomboid', 'satisfactory', 'ark', 'asa', 'valheim', 'sevendays', 'palworld', 'terraria'];

export const isGameId = (value: string): value is GameId => (GAME_ORDER as readonly string[]).includes(value);
