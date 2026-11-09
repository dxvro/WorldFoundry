import type { GameId } from '@worldfoundry/backend/contract';
import type { ReactNode } from 'react';
import { cx } from '../components/ui';
import { useGames } from './GamesProvider';

// The disclaimer of one game, shown wherever a page is about that game. Nothing is shown until the text has arrived:
// the general disclaimer of the shell is always there.
export function GameDisclaimer({ game, className }: { game: GameId; className?: string }): ReactNode {
  const text = useGames().find(game)?.disclaimer;
  if (text === undefined) return null;
  return <p className={cx('text-xs leading-snug text-faint', className)}>{text}</p>;
}
