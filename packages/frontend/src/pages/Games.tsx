import type { GameDefinition } from '@worldfoundry/backend/contract';
import { ExternalLink, Plus } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { Button, ErrorNotice, LoadingBlock, Section } from '../components/ui';
import { useGames } from '../games/GamesProvider';
import { GameTile } from '../games/GameTile';
import { useI18n } from '../i18n';
import { useLive } from '../live/LiveProvider';
import { useRouter } from '../lib/router';

function Fact({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="grid gap-x-4 gap-y-0.5 sm:grid-cols-[9rem_1fr]">
      <dt className="text-sm text-faint">{label}</dt>
      <dd className="min-w-0 text-sm text-dim">{children}</dd>
    </div>
  );
}

const external = { target: '_blank', rel: 'noopener noreferrer' } as const;

export function GameCard({ game, serverCount }: { game: GameDefinition; serverCount: number }): ReactNode {
  const { t } = useI18n();
  const { navigate } = useRouter();
  const available = game.availability === 'available';
  return (
    <li className="panel space-y-4 p-4 sm:p-5" data-testid="game-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <GameTile game={game.id} size="lg" muted={!available} />
          <div className="min-w-0">
            <h2 className="text-base">{game.name}</h2>
            <p className="flex flex-wrap items-center gap-2 text-sm text-dim">
              <span className={available ? 'chip chip-ok' : 'chip'}>{available ? t.games.available : t.games.planned}</span>
              {available ? <span className="num">{t.games.serverCount(serverCount)}</span> : null}
            </p>
          </div>
        </div>
        {available ? (
          <Button size="sm" icon={Plus} onClick={() => navigate(`/new/${game.id}`)}>
            {t.games.createServer}
          </Button>
        ) : null}
      </div>
      <p className="text-dim">{game.summary}</p>
      {available ? null : <p className="hint">{t.games.plannedHint}</p>}
      <dl className="space-y-2">
        <Fact label={t.games.facts.delivery}>{game.delivery.kind === 'steamcmd' ? t.games.delivery.steamcmd(game.delivery.appId) : t.games.delivery.vendor}</Fact>
        <Fact label={t.games.facts.size}>
          <span className="num">{`${t.games.disk(game.diskGb)} · ${t.games.ram(game.ramGb)}`}</span>
        </Fact>
        <Fact label={t.games.facts.platforms}>{game.platforms.map((platform) => t.games.platform[platform]).join(', ')}</Fact>
        <Fact label={t.games.facts.ports}>
          <span className="num">{game.ports.map((port) => t.games.port(port.purpose, port.port, port.protocol)).join(' · ')}</span>
        </Fact>
        <Fact label={t.games.facts.mods}>
          <ul className="space-y-1">
            {game.modSources.map((source) => (
              <li key={source.id}>
                <a href={source.url} {...external} className="inline-flex items-center gap-1">
                  {source.name}
                  <ExternalLink aria-hidden className="size-3.5" />
                </a>
                {source.inProgress === true ? <span className="chip chip-busy ml-2">{t.games.inProgress}</span> : null}
                {source.requiresKey ? <span className="chip ml-2">{t.games.needsKey}</span> : null}
                {source.note === undefined ? null : <p className="hint">{source.note}</p>}
              </li>
            ))}
          </ul>
        </Fact>
        {game.eula === null ? null : (
          <Fact label={t.games.facts.license}>
            <a href={game.eula.url} {...external} className="inline-flex items-center gap-1">
              {game.eula.name}
              <ExternalLink aria-hidden className="size-3.5" />
            </a>
          </Fact>
        )}
        <Fact label={t.games.facts.rights}>{game.rightsHolders.join(', ')}</Fact>
      </dl>
      <p className="border-t border-line pt-3 text-sm font-medium text-ink">{game.disclaimer}</p>
    </li>
  );
}

export function GamesPage(): ReactNode {
  const { t } = useI18n();
  const { games, error, reload } = useGames();
  const servers = useLive().state.servers ?? [];

  useEffect(() => {
    document.title = t.games.documentTitle;
  }, [t]);

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h1 className="text-2xl">{t.games.title}</h1>
        <p className="max-w-3xl text-dim">{t.games.intro}</p>
      </div>
      {games === null ? (
        <LoadingBlock label={t.games.loading} />
      ) : error !== null ? (
        <ErrorNotice error={error} title={t.games.loadFailed} action={<Button size="sm" onClick={reload}>{t.common.retry}</Button>} />
      ) : (
        <ul className="grid gap-4 xl:grid-cols-2" aria-label={t.games.title}>
          {games.map((game) => (
            <GameCard key={game.id} game={game} serverCount={servers.filter((server) => server.game === game.id).length} />
          ))}
        </ul>
      )}
      <Section title={t.games.legalTitle}>
        <p className="max-w-3xl text-dim">{t.games.legalBody}</p>
      </Section>
    </div>
  );
}
