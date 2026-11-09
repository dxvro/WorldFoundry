import { Cpu, Globe, HardDrive, Plus, Server, Users } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { ActionBar, ActionFeedback, useServerActions } from '../components/ServerActions';
import { LOADER_LABEL, Meter, StatusChip } from '../components/status';
import { Button, EmptyState, ErrorNotice, LoadingBlock, Notice } from '../components/ui';
import { renderOptionalRef, renderRef, useI18n } from '../i18n';
import { useLive } from '../live/LiveProvider';
import type { CrashInfo, InstallProgress } from '../live/reducer';
import { systemApi } from '../lib/endpoints';
import { formatBytes, formatDuration, formatMb, formatPercent, plural } from '../lib/format';
import { Link, serverPath, useRouter } from '../lib/router';
import type { HealthInfo, RuntimeStatus, ServerView, SystemInfo } from '../lib/types';
import { useQuery, type QueryState } from '../lib/useQuery';

function lanHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function HostPanel({ health, system }: { health: QueryState<HealthInfo | null>; system: QueryState<SystemInfo> }): ReactNode {
  const { t } = useI18n();
  const urls = health.data?.lanUrls ?? [];
  const info = system.data;

  return (
    <section aria-label={t.overview.hostPanel} className="panel grid gap-x-8 gap-y-3 p-4 sm:grid-cols-2 xl:grid-cols-[1.4fr_1fr_1fr]">
      <div className="min-w-0 space-y-1">
        <h2 className="flex items-center gap-2 text-sm text-dim">
          <Globe aria-hidden className="size-4" />
          {t.overview.hostAddresses}
        </h2>
        {urls.length === 0 ? (
          <p className="hint">{health.loading ? t.overview.determining : t.overview.noLanAddress}</p>
        ) : (
          <ul className="space-y-0.5">
            {urls.map((url) => (
              <li key={url} className="num select-all font-mono text-sm">
                {url}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="min-w-0 space-y-1">
        <h2 className="flex items-center gap-2 text-sm text-dim">
          <HardDrive aria-hidden className="size-4" />
          {t.overview.memory}
        </h2>
        {info === undefined ? (
          <p className="hint">{system.loading ? t.overview.determining : t.overview.notAvailable}</p>
        ) : (
          <p className="num">
            <span className="text-lg font-semibold">{formatMb(info.totalMemoryMb)}</span> <span className="text-dim">{t.overview.memoryFree(formatMb(info.freeMemoryMb))}</span>
          </p>
        )}
      </div>
      <div className="min-w-0 space-y-1 sm:col-span-2 xl:col-span-1">
        <h2 className="flex items-center gap-2 text-sm text-dim">
          <Cpu aria-hidden className="size-4" />
          {t.overview.cpuAndJava}
        </h2>
        {info === undefined ? (
          <p className="hint">{system.loading ? t.overview.determining : t.overview.notAvailable}</p>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="num">{plural(info.cpuCount, t.overview.coreSingular, t.overview.corePlural)}</span>
            {info.javaRuntimes.length === 0 ? (
              <span className="chip chip-warn">{t.overview.noJava}</span>
            ) : (
              info.javaRuntimes.map((runtime) => (
                <span key={runtime.path} className="chip" title={runtime.path}>
                  Java {runtime.major}
                </span>
              ))
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function Summary({ servers, statuses }: { servers: ServerView[]; statuses: RuntimeStatus[] }): ReactNode {
  const { t } = useI18n();
  const online = statuses.filter((status) => status.state === 'online').length;
  const players = statuses.reduce((sum, status) => sum + status.players.length, 0);
  return (
    <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-dim">
      <span className="num">
        <strong className="text-ink">{online}</strong> {t.overview.ofOnline(servers.length)}
      </span>
      <span className="num inline-flex items-center gap-1.5">
        <Users aria-hidden className="size-4" />
        <strong className="text-ink">{players}</strong> {players === 1 ? t.overview.playerSingular : t.overview.playerPlural}
      </span>
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

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim() !== '') ?? text;
}

function ServerRow({ server, status, install, crash, host }: RowProps): ReactNode {
  const { t } = useI18n();
  const actions = useServerActions(server.id);
  const running = status.state !== 'offline' && status.state !== 'crashed';
  const ramRatio = status.rssBytes === null ? null : status.rssBytes / (server.maxRamMb * 1024 * 1024);
  const installed = server.installState === 'installed';
  const port = status.port ?? server.port;
  const installErrorText = renderOptionalRef(server.installErrorRef, t, server.installError);

  return (
    <li className="panel">
      <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1.5fr)_9rem_minmax(16rem,1.6fr)_minmax(0,1fr)_21.5rem] xl:items-center">
        <div className="min-w-0 space-y-1">
          <h3 className="text-base">
            <Link to={serverPath(server.id)} className="text-ink hover:text-accent">
              {server.name}
            </Link>
          </h3>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-dim">
            <span className="chip">{LOADER_LABEL[server.loader]}</span>
            <span className="num">{t.overview.minecraftVersion(server.mcVersion)}</span>
            <span className="num text-faint" title={host === null ? undefined : t.overview.connectTo(`${host}:${port}`)}>
              {t.overview.portLabel(port)}
            </span>
          </p>
        </div>

        <div className="min-w-0 space-y-1">
          <StatusChip server={server} status={status} />
          {!installed ? (
            <p className="text-sm text-dim">
              {server.installState === 'failed' ? (
                <>
                  <span className="line-clamp-2">{installErrorText === undefined ? t.common.unknownError : firstLine(installErrorText)}</span>
                  <Link to={serverPath(server.id)}>{t.overview.detailsAgain}</Link>
                </>
              ) : install === undefined ? (
                t.overview.waiting
              ) : (
                <span className="num">
                  {renderRef(install.messageRef, t, install.message)}
                  {install.percent === null ? '' : ` (${Math.round(install.percent)} %)`}
                </span>
              )}
            </p>
          ) : status.state === 'crashed' ? (
            <p className="text-sm text-bad">
              {status.exitCode === null ? (renderOptionalRef(status.messageRef, t, status.message) ?? t.overview.unexpectedStop) : t.overview.exitCode(status.exitCode)}{' '}
              <Link to={serverPath(server.id)}>{crash === undefined ? t.overview.details : t.overview.detailsWithLog}</Link>
            </p>
          ) : status.state === 'preparing' ? (
            <p className="num text-sm text-accent">{renderOptionalRef(status.messageRef, t, status.message) ?? t.overview.preparing}</p>
          ) : running && status.startedAt !== null ? (
            <p className="num text-sm text-dim">{t.overview.runningFor(formatDuration(Date.now() - status.startedAt))}</p>
          ) : null}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="min-w-0 space-y-1">
            <p className="num flex justify-between text-xs text-dim">
              <span>CPU</span>
              <span>{formatPercent(status.cpuPercent)}</span>
            </p>
            <Meter label={t.overview.cpuOf(server.name)} value={status.cpuPercent === null ? null : status.cpuPercent / 100} valueText={formatPercent(status.cpuPercent)} />
          </div>
          <div className="min-w-0 space-y-1">
            <p className="num flex justify-between gap-2 text-xs text-dim">
              <span>RAM</span>
              <span className="whitespace-nowrap">{status.rssBytes === null ? '–' : `${formatBytes(status.rssBytes)} / ${formatMb(server.maxRamMb)}`}</span>
            </p>
            <Meter label={t.overview.memoryOf(server.name)} value={ramRatio} valueText={status.rssBytes === null ? t.overview.notMeasured : formatBytes(status.rssBytes)} />
          </div>
        </div>

        <div className="min-w-0">
          <p className="num flex items-center gap-1.5 text-sm">
            <Users aria-hidden className="size-4 shrink-0 text-dim" />
            <span>{plural(status.players.length, t.overview.playerSingular, t.overview.playerPlural)}</span>
          </p>
          {status.players.length > 0 ? (
            <p className="truncate text-sm text-dim" title={status.players.join(', ')}>
              {status.players.join(', ')}
            </p>
          ) : null}
        </div>

        <div className="xl:flex xl:justify-end">
          <ActionBar server={server} status={status} actions={actions} compact />
        </div>
      </div>
      {actions.error !== null || actions.warnings.length > 0 ? (
        <div className="border-t border-line p-4">
          <ActionFeedback serverId={server.id} actions={actions} />
        </div>
      ) : null}
    </li>
  );
}

export function Overview(): ReactNode {
  const { t } = useI18n();
  const { state, statusFor, listError, refresh } = useLive();
  const { navigate } = useRouter();
  const servers = state.servers;

  useEffect(() => {
    document.title = t.overview.documentTitle;
  }, [t]);

  const health = useQuery<HealthInfo | null>(() => systemApi.health().catch(() => null), []);
  const system = useQuery((signal) => systemApi.system(false, signal), []);
  const host = (health.data?.lanUrls ?? [])[0];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl">{t.overview.title}</h1>
          {servers === null ? null : <Summary servers={servers} statuses={servers.map((server) => statusFor(server))} />}
        </div>
        <Button variant="primary" icon={Plus} onClick={() => navigate('/new')}>
          {t.shell.newServer}
        </Button>
      </div>

      <HostPanel health={health} system={system} />

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
          <ul className="space-y-3" aria-label={t.overview.serversLabel}>
            {servers.map((server) => (
              <ServerRow
                key={server.id}
                server={server}
                status={statusFor(server)}
                install={state.installs[server.id]}
                crash={state.crashes[server.id]}
                host={host === undefined ? null : lanHost(host)}
              />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
