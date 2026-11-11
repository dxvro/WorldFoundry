import type { GameId } from '@worldfoundry/backend/contract';
import type { ReactNode } from 'react';
import { cx } from '../components/ui';
import { GAME_LOOK } from './look';

const SIZES = {
  sm: { box: 'size-6 rounded-md', icon: 'size-3.5' },
  md: { box: 'size-10 rounded-lg', icon: 'size-5' },
  lg: { box: 'size-14 rounded-xl', icon: 'size-7' },
} as const;

// The coloured symbol of a game, so that the games are told apart at a glance. Decorative: the name always sits next to it.
export function GameTile({ game, size = 'md', muted = false }: { game: GameId; size?: keyof typeof SIZES; muted?: boolean }): ReactNode {
  const look = GAME_LOOK[game];
  const Icon = look.icon;
  const style = muted
    ? undefined
    : { backgroundColor: `oklch(0.32 0.07 ${look.hue})`, color: `oklch(0.86 0.13 ${look.hue})`, boxShadow: `inset 0 0 0 1px oklch(0.45 0.09 ${look.hue})` };
  return (
    <span aria-hidden data-testid="game-tile" className={cx('grid shrink-0 place-items-center', SIZES[size].box, muted ? 'bg-raised text-faint' : null)} style={style}>
      <Icon className={SIZES[size].icon} />
    </span>
  );
}
