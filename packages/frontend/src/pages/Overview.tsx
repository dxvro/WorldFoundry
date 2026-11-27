import { Plus, RefreshCw, Server, Upload } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { ActionBar, ActionFeedback, useServerActions } from '../components/ServerActions';
import { LOADER_LABEL, StatusChip } from '../components/status';
import { Button, EmptyState, ErrorNotice, LoadingBlock, Notice, cx } from '../components/ui';
import { useGames } from '../games/GamesProvider';
import { GameTile } from '../games/GameTile';
import { GAME_ORDER } from '../games/look';
import { renderOptionalRef, renderRef, useI18n } from '../i18n';
import { formatDuration, formatInt } from '../lib/format';
import { useLanHost } from '../lib/lan';
import { Link, serverPath, useRouter } from '../lib/router';
import type { RuntimeStatus, ServerState, ServerView } from '../lib/types';
import { useLive } from '../live/LiveProvider';
import type { CrashInfo, InstallProgress } from '../live/reducer';

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim() !== '') ?? text;
}

// players a status knows: names when the game lists them, else the bare count of games that only count
const playerCount = (status: RuntimeStatus): number => (status.players.length > 0 ? status.players.length : (status.playerCount ?? 0));

// one figure of the summary: a small label above a large number
function Metric({ label, value, delay }: { label: string; value: number; delay: number }): ReactNode {
  return (
    <div className="panel flex min-w-40 flex-1 flex-col gap-1 px-5 py-4" style={{ animationDelay: `${delay}ms` }}>
      <dt className="text-sm font-semibold text-dim">{label}</dt>
      <dd className="num m-0 text-3xl leading-tight font-extrabold text-ink">{formatInt(value)}</dd>
    </div>
  );
}

type Filter = 'all' | 'running' | 'stopped';
type SortKey = 'game' | 'name' | 'status' | 'players';
const FILTERS: readonly Filter[] = ['all', 'running', 'stopped'];
const SORT_KEYS: readonly SortKey[] = ['game', 'name', 'status', 'players'];

// running servers first, then the ones on their way, then the stopped ones
const STATE_RANK: Record<ServerState, number> = { online: 0, starting: 1, preparing: 2, stopping: 3, crashed: 4, offline: 5 };
// "running" in the filter: everything that has a process or is about to
const isUp = (state: ServerState): boolean => state === 'online' || state === 'starting' || state === 'preparing' || state === 'stopping';

interface RowProps {
  server: ServerView;
  status: RuntimeStatus;
  install: InstallProgress | undefined;
  crash: CrashInfo | undefined;
  host: string | null;
}

// What the status column says below the chip: install progress, a crash, the preparation or how long it runs
function StatusDetail({ server, status, install, crash }: Omit<RowProps, 'host'>): ReactNode {
  const { t } = useI18n();
  const installErrorText = renderOptionalRef(server.installErrorRef, t, server.installError);
  if (server.installState !== 'installed') {
    if (server.installState === 'failed') {
      return (
        <p className="text-xs text-dim">
          <span className="line-clamp-2">{installErrorText === undefined ? t.common.unknownError : firstLine(installErrorText)}</span>
          <Link to={serverPath(server.id)}>{t.overview.detailsAgain}</Link>
        </p>
      );
    }
    if (install === undefined) return <p className="text-xs text-dim">{t.overview.waiting}</p>;
    return (
      <div className="space-y-1">
        {install.percent === null ? null : (
          <div className="h-1.5 w-40 max-w-full overflow-hidden rounded-full bg-line" aria-hidden>
            <div className="h-full bg-warn" style={{ width: `${Math.max(2, Math.round(install.percent))}%` }} />
          </div>
        )}
        <p className="num text-xs text-dim">
          {renderRef(install.messageRef, t, install.message)}
          {install.percent === null ? '' : ` (${Math.round(install.percent)} %)`}
        </p>
      </div>
    );
  }
  if (status.state === 'crashed') {
    return (
      <p className="text-xs text-bad">
        {status.exitCode === null ? (renderOptionalRef(status.messageRef, t, status.message) ?? t.overview.unexpectedStop) : t.overview.exitCode(status.exitCode)}{' '}
        <Link to={serverPath(server.id)}>{crash === undefined ? t.overview.details : t.overview.detailsWithLog}</Link>
      </p>
    );
  }
  if (status.state === 'preparing') return <p className="num text-xs text-accent">{renderOptionalRef(status.messageRef, t, status.message) ?? t.overview.preparing}</p>;
  if ((status.state === 'online' || status.state === 'starting') && status.startedAt !== null) {
    return <p className="num text-xs text-faint">{t.overview.runningFor(formatDuration(Date.now() - status.startedAt))}</p>;
  }
  return null;
}

function ServerCard({ server, status, install, crash, host, delay }: RowProps & { delay: number }): ReactNode {
  const { t } = useI18n();
  const { nameOf } = useGames();
  const actions = useServerActions(server.id);
  const port = status.port ?? server.port;
  const players = playerCount(status);
  const online = status.state === 'online';
  const subtitle = server.game === 'minecraft' ? `${LOADER_LABEL[server.loader]} · ${t.overview.minecraftVersion(server.mcVersion)}` : nameOf(server.game);
  return (
    <li data-testid="server-card" className={cx('panel server-card flex min-w-0 flex-col gap-4 p-5', online && 'server-card-online')} style={{ animationDelay: `${delay}ms` }}>
      <div className="flex items-start gap-3">
        <Link to={serverPath(server.id)} className="flex min-w-0 flex-1 items-center gap-3 text-ink no-underline hover:text-accent">
          <GameTile game={server.game} />
          <span className="min-w-0">
            <span className="block truncate text-base font-extrabold">{server.name}</span>
            <span className="block truncate text-sm text-faint">{subtitle}</span>
          </span>
        </Link>
        <StatusChip server={server} status={status} />
      </div>
      <StatusDetail server={server} status={status} install={install} crash={crash} />
      <dl className="m-0 mt-auto grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-dim">{t.overview.columns.players}</dt>
        <dd className="num m-0 text-right font-bold" title={status.players.length > 0 ? status.players.join(', ') : undefined}>
          {online ? players : <span className="text-faint">{t.overview.noPlayers}</span>}
        </dd>
        <dt className="text-dim">{t.overview.columns.join}</dt>
        <dd className="num m-0 min-w-0 text-right font-bold">
          <span className="select-all" title={t.overview.connectTo(`${host ?? ''}:${port}`)}>
            {host === null ? t.overview.portLabel(port) : `${host}:${port}`}
          </span>
        </dd>
      </dl>
      <ActionBar server={server} status={status} actions={actions} compact menu />
      {actions.error !== null || actions.warnings.length > 0 ? <ActionFeedback serverId={server.id} actions={actions} /> : null}
    </li>
  );
}

export function Overview(): ReactNode {
  const { t } = useI18n();
  const { state, statusFor, listError, refresh } = useLive();
  const { navigate } = useRouter();
  const host = useLanHost();
  const servers = state.servers;

  useEffect(() => {
    document.title = t.overview.documentTitle;
  }, [t]);

  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<SortKey>('game');

  // one list, ordered like the games page and then by name; the tile in each row tells the games apart
  const byGame = (a: ServerView, b: ServerView): number => GAME_ORDER.indexOf(a.game) - GAME_ORDER.indexOf(b.game) || a.name.localeCompare(b.name);
  const shown = (servers ?? [])
    .filter((server) => filter === 'all' || isUp(statusFor(server).state) === (filter === 'running'))
    .sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name) || byGame(a, b);
      if (sort === 'players') return playerCount(statusFor(b)) - playerCount(statusFor(a)) || byGame(a, b);
      if (sort === 'status') return STATE_RANK[statusFor(a).state] - STATE_RANK[statusFor(b).state] || byGame(a, b);
      return byGame(a, b);
    });
  const statuses = (servers ?? []).map((server) => statusFor(server));
  const running = statuses.filter((status) => status.state === 'online' || status.state === 'starting').length;
  const up = statuses.filter((status) => isUp(status.state)).length;
  const counts: Record<Filter, number> = { all: statuses.length, running: up, stopped: statuses.length - up };
  const players = statuses.reduce((sum, status) => sum + playerCount(status), 0);

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-2xl">{t.overview.title}</h1>

      {listError !== null && servers === null ? (
        <ErrorNotice error={new Error(listError)} title={t.overview.listLoadFailed} action={<Button size="sm" onClick={() => void refresh()}>{t.common.retry}</Button>} />
      ) : servers === null ? (
        <LoadingBlock label={t.overview.loadingServers} />
      ) : servers.length === 0 ? (
        <EmptyState
          icon={Server}
          title={t.overview.noServerYet}
          action={
            <Button variant="primary" icon={Plus} onClick={() => navigate('/new')}>
              {t.overview.createFirst}
            </Button>
          }
        >
          <p>{t.overview.wizardIntro}</p>
        </EmptyState>
      ) : (
        <>
          {listError === null ? null : <Notice tone="warn">{t.overview.listStale(listError)}</Notice>}
          <dl className="m-0 flex flex-wrap gap-4">
            <Metric label={t.overview.metrics.servers} value={servers.length} delay={0} />
            <Metric label={t.overview.metrics.running} value={running} delay={60} />
            <Metric label={t.overview.metrics.players} value={players} delay={120} />
          </dl>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <div role="group" aria-label={t.overview.filters.label} className="tabs">
              {FILTERS.map((key) => (
                <button key={key} type="button" aria-pressed={filter === key} onClick={() => setFilter(key)} className="tab">
                  {t.overview.filters[key]}
                  <span className="tab-count num">{counts[key]}</span>
                </button>
              ))}
            </div>
            <label className="flex items-center gap-2 text-sm text-dim">
              {t.overview.sort.label}
              <select className="input w-auto py-0" value={sort} onChange={(event) => setSort(event.target.value as SortKey)}>
                {SORT_KEYS.map((key) => (
                  <option key={key} value={key}>
                    {t.overview.sort[key]}
                  </option>
                ))}
              </select>
            </label>
            <div className="ml-auto flex flex-wrap gap-2">
              <Button icon={RefreshCw} className="bg-transparent" onClick={() => void refresh()}>
                {t.overview.refresh}
              </Button>
              <Button icon={Upload} className="bg-transparent" onClick={() => navigate('/new/world')}>
                {t.overview.importWorld}
              </Button>
              <Button variant="primary" icon={Plus} onClick={() => navigate('/new')}>
                {t.shell.newServer}
              </Button>
            </div>
          </div>

          {shown.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-line-strong p-8 text-center text-dim">{t.overview.noMatch}</p>
          ) : (
            <ul aria-label={t.overview.serversLabel} className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(100%,19rem),1fr))] gap-4 p-0">
              {shown.map((server, index) => (
                <ServerCard key={server.id} server={server} status={statusFor(server)} install={state.installs[server.id]} crash={state.crashes[server.id]} host={host} delay={Math.min(index, 8) * 60} />
              ))}
            </ul>
          )}
          <p className="num text-sm text-dim">{t.overview.shown(shown.length, servers.length)}</p>
        </>
      )}
    </div>
  );
}
