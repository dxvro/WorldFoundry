import type { GameDefinition } from '@worldfoundry/backend/contract';
import { ChevronRight, Cpu, HardDrive, Search, Upload } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Button, ErrorNotice, Field, LoadingBlock, cx } from '../components/ui';
import { useGames } from '../games/GamesProvider';
import { GameTile } from '../games/GameTile';
import { GAME_LOOK } from '../games/look';
import { useI18n } from '../i18n';
import { Link } from '../lib/router';

const normalize = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// a game matches when every word of the query starts a word of its name, short name, summary or mod sources
export function matchesGame(game: GameDefinition, query: string): boolean {
  const words = normalize(query).split(' ').filter(Boolean);
  if (words.length === 0) return true;
  const haystack = normalize([game.name, GAME_LOOK[game.id].shortName, game.summary, ...game.modSources.map((source) => source.name)].join(' ')).split(' ');
  return words.every((word) => haystack.some((part) => part.startsWith(word)));
}

function GameChoice({ game }: { game: GameDefinition }): ReactNode {
  const { t } = useI18n();
  const available = game.availability === 'available';
  const body = (
    <>
      <div className="flex items-start gap-3">
        <GameTile game={game.id} size="lg" muted={!available} />
        <div className="min-w-0 flex-1 space-y-1">
          <span className={cx('block text-base font-medium', available ? 'text-ink' : 'text-dim')}>{game.name}</span>
          <span className="block text-sm leading-snug text-dim">{game.summary}</span>
        </div>
        {available ? <ChevronRight aria-hidden className="mt-1 size-5 shrink-0 text-dim" /> : <span className="chip shrink-0">{t.games.planned}</span>}
      </div>
      <span className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-faint">
        <span className="num inline-flex items-center gap-1">
          <HardDrive aria-hidden className="size-3.5" />
          {t.games.disk(game.diskGb)}
        </span>
        <span className="num inline-flex items-center gap-1">
          <Cpu aria-hidden className="size-3.5" />
          {t.games.ram(game.ramGb)}
        </span>
        <span>{t.games.modsFrom(game.modSources.map((source) => source.name).join(', '))}</span>
      </span>
      <span className="block text-xs leading-snug text-faint">{game.disclaimer}</span>
    </>
  );
  return (
    <li>
      {available ? (
        <Link to={`/new/${game.id}`} className="panel flex h-full flex-col gap-3 p-4 no-underline hover:border-line-strong hover:bg-raised">
          {body}
        </Link>
      ) : (
        <div className="panel flex h-full flex-col gap-3 p-4 opacity-75" aria-disabled="true" title={t.games.plannedHint}>
          {body}
        </div>
      )}
    </li>
  );
}

// First step of "New server": which game. A planned game is shown, so that it is clear what is coming, but cannot be chosen.
export function NewServer(): ReactNode {
  const { t } = useI18n();
  const { games, error, reload } = useGames();
  const [query, setQuery] = useState('');

  useEffect(() => {
    document.title = t.games.pickDocumentTitle;
  }, [t]);

  const shown = games?.filter((game) => matchesGame(game, query)) ?? [];

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div className="space-y-1">
        <h1 className="text-2xl">{t.games.pickTitle}</h1>
        <p className="text-dim">{t.games.pickIntro}</p>
      </div>
      {games === null ? (
        <LoadingBlock label={t.games.loading} />
      ) : error !== null ? (
        <ErrorNotice error={error} title={t.games.loadFailed} action={<Button size="sm" onClick={reload}>{t.common.retry}</Button>} />
      ) : (
        <>
          <form role="search" className="max-w-sm" onSubmit={(event) => event.preventDefault()}>
            <Field label={t.games.searchLabel}>
              {(props) => (
                <div className="relative">
                  <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
                  <input {...props} type="search" className="input pl-9" value={query} autoComplete="off" placeholder={t.games.searchPlaceholder} onChange={(event) => setQuery(event.target.value)} />
                </div>
              )}
            </Field>
          </form>
          {shown.length === 0 ? (
            <p className="text-dim" role="status">
              {t.games.noMatch(query.trim())}
            </p>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2" aria-label={t.games.pickLabel}>
              {shown.map((game) => (
                <GameChoice key={game.id} game={game} />
              ))}
            </ul>
          )}
        </>
      )}
      <Link to="/new/world" className="link-btn gap-1.5">
        <Upload aria-hidden className="size-4" />
        {t.games.fromWorld}
      </Link>
    </div>
  );
}
