import { ChevronRight, Upload } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { Button, ErrorNotice, LoadingBlock, cx } from '../components/ui';
import { useGames } from '../games/GamesProvider';
import { GAME_LOOK } from '../games/look';
import { useI18n } from '../i18n';
import { Link } from '../lib/router';

// First step of "New server": which game. A planned game is shown, so that it is clear what is coming, but cannot be chosen.
export function NewServer(): ReactNode {
  const { t } = useI18n();
  const { games, error, reload } = useGames();

  useEffect(() => {
    document.title = t.games.pickDocumentTitle;
  }, [t]);

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div className="space-y-1">
        <h1 className="text-2xl">{t.games.pickTitle}</h1>
        <p className="text-dim">{t.games.pickIntro}</p>
      </div>
      {games === null ? (
        <LoadingBlock label={t.games.loading} />
      ) : error !== null ? (
        <ErrorNotice error={error} title={t.games.loadFailed} action={<Button size="sm" onClick={reload}>{t.common.retry}</Button>} />
      ) : (
        <ul className="space-y-3" aria-label={t.games.pickLabel}>
          {games.map((game) => {
            const Icon = GAME_LOOK[game.id].icon;
            const available = game.availability === 'available';
            const body = (
              <>
                <span className={cx('grid size-10 shrink-0 place-items-center rounded-lg bg-raised', available ? 'text-accent' : 'text-faint')}>
                  <Icon aria-hidden className="size-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className={cx('block text-base font-medium', available ? 'text-ink' : 'text-dim')}>{game.name}</span>
                  <span className="block text-xs leading-snug text-faint">{game.disclaimer}</span>
                </span>
                {available ? <ChevronRight aria-hidden className="size-5 shrink-0 text-dim" /> : <span className="chip shrink-0">{t.games.planned}</span>}
              </>
            );
            return (
              <li key={game.id}>
                {available ? (
                  <Link to={`/new/${game.id}`} className="panel flex items-center gap-3 p-4 no-underline hover:border-line-strong hover:bg-raised">
                    {body}
                  </Link>
                ) : (
                  <div className="panel flex items-center gap-3 p-4 opacity-75" aria-disabled="true" title={t.games.plannedHint}>
                    {body}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <Link to="/new/world" className="link-btn gap-1.5">
        <Upload aria-hidden className="size-4" />
        {t.games.fromWorld}
      </Link>
    </div>
  );
}
