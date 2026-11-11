import { Plus, Server } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { ActionBar, ActionFeedback, useServerActions } from '../components/ServerActions';
import { LOADER_LABEL, StatusChip } from '../components/status';
import { Button, EmptyState, ErrorNotice, LoadingBlock, Notice } from '../components/ui';
import { useGames } from '../games/GamesProvider';
import { GameTile } from '../games/GameTile';
import { GAME_ORDER } from '../games/look';
import { renderOptionalRef, renderRef, useI18n } from '../i18n';
import { formatDuration } from '../lib/format';
import { useLanHost } from '../lib/lan';
import { Link, serverPath, useRouter } from '../lib/router';
import type { RuntimeStatus, ServerView } from '../lib/types';
import { useLive } from '../live/LiveProvider';
import type { CrashInfo, InstallProgress } from '../live/reducer';

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim() !== '') ?? text;
}

// players a status knows: names when the game lists them, else the bare count of games that only count
const playerCount = (status: RuntimeStatus): number => (status.players.length > 0 ? status.players.length : (status.playerCount ?? 0));

function Summary({ statuses }: { statuses: RuntimeStatus[] }): ReactNode {
  const { t } = useI18n();
  const running = statuses.filter((status) => status.state === 'online' || status.state === 'starting').length;
  const players = statuses.reduce((sum, status) => sum + playerCount(status), 0);
  return (
    <p className="num text-dim">
      {t.overview.running(running)} · {t.overview.playersOnline(players)}
    </p>
  );
}

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

function ServerRow({ server, status, install, crash, host }: RowProps): ReactNode {
  const { t } = useI18n();
  const { nameOf } = useGames();
  const actions = useServerActions(server.id);
  const port = status.port ?? server.port;
  const players = playerCount(status);
  const subtitle = server.game === 'minecraft' ? `${LOADER_LABEL[server.loader]} · ${t.overview.minecraftVersion(server.mcVersion)}` : nameOf(server.game);
  return (
    <>
      <tr className="border-t border-line align-middle">
        <td className="px-4 py-3">
          <Link to={serverPath(server.id)} className="flex min-w-0 items-center gap-3 text-ink no-underline hover:text-accent">
            <GameTile game={server.game} />
            <span className="min-w-0">
              <span className="block truncate font-medium">{server.name}</span>
              <span className="block truncate text-xs text-faint">{subtitle}</span>
            </span>
          </Link>
        </td>
        <td className="px-3 py-3">
          <div className="space-y-1">
            <StatusChip server={server} status={status} />
            <StatusDetail server={server} status={status} install={install} crash={crash} />
          </div>
        </td>
        <td className="num px-3 py-3" title={status.players.length > 0 ? status.players.join(', ') : undefined}>
          {status.state === 'online' ? players : <span className="text-faint">{t.overview.noPlayers}</span>}
        </td>
        <td className="num px-3 py-3 text-dim">
          <span className="select-all whitespace-nowrap" title={t.overview.connectTo(`${host ?? ''}:${port}`)}>
            {host === null ? t.overview.portLabel(port) : `${host}:${port}`}
          </span>
        </td>
        <td className="px-4 py-3">
          <div className="flex justify-end">
            <ActionBar server={server} status={status} actions={actions} compact menu />
          </div>
        </td>
      </tr>
      {actions.error !== null || actions.warnings.length > 0 ? (
        <tr>
          <td colSpan={5} className="px-4 pb-3">
            <ActionFeedback serverId={server.id} actions={actions} />
          </td>
        </tr>
      ) : null}
    </>
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

  // one list, ordered like the games page and then by name; the tile in each row tells the games apart
  const sorted = servers === null ? [] : [...servers].sort((a, b) => GAME_ORDER.indexOf(a.game) - GAME_ORDER.indexOf(b.game) || a.name.localeCompare(b.name));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl">{t.overview.title}</h1>
          {servers === null ? null : <Summary statuses={servers.map((server) => statusFor(server))} />}
        </div>
        <Button variant="primary" icon={Plus} onClick={() => navigate('/new')}>
          {t.shell.newServer}
        </Button>
      </div>

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
          <div className="panel overflow-x-auto p-0">
            <table className="w-full min-w-[46rem] border-collapse text-left" aria-label={t.overview.serversLabel}>
              <thead>
                <tr className="text-xs text-faint">
                  <th scope="col" className="px-4 py-2.5 font-medium">{t.overview.columns.server}</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">{t.overview.columns.status}</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">{t.overview.columns.players}</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">{t.overview.columns.join}</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    <span className="sr-only">{t.overview.columns.actions}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((server) => (
                  <ServerRow key={server.id} server={server} status={statusFor(server)} install={state.installs[server.id]} crash={state.crashes[server.id]} host={host} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
