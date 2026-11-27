import { AlertTriangle, Cpu, HardDrive, MemoryStick, Server as ServerIcon } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { Sparkline, type SparkPoint } from '../components/Sparkline';
import { StatusChip } from '../components/status';
import { Button, ErrorNotice, LoadingBlock, Section, cx } from '../components/ui';
import { useGames } from '../games/GamesProvider';
import { useI18n } from '../i18n';
import { useLive } from '../live/LiveProvider';
import { systemApi } from '../lib/endpoints';
import { formatBytes, formatDuration, formatPercent } from '../lib/format';
import { Link, serverPath } from '../lib/router';
import type { ServerView, UsageResponse } from '../lib/types';
import { useQuery } from '../lib/useQuery';

const HIGH = 85;
const MB = 1024 * 1024;
// Only the Java servers get a memory limit (-Xmx). The other games have no such setting and take what they need.
const LIMITED: ReadonlySet<string> = new Set(['minecraft', 'zomboid']);

function HighBadge(): ReactNode {
  const { t } = useI18n();
  return (
    <span className="chip chip-warn">
      <AlertTriangle aria-hidden className="size-3" />
      {t.usage.high}
    </span>
  );
}

// A filled share of a whole: the bar of disk and per-server memory
function Meter({ value, max, label }: { value: number; max: number; label: string }): ReactNode {
  const percent = max <= 0 ? 0 : Math.min(100, (value / max) * 100);
  return (
    <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} className="h-2 overflow-hidden rounded-full bg-line">
      <div className={cx('h-full rounded-full', percent >= HIGH ? 'bg-warn' : 'bg-accent')} style={{ width: `${percent}%` }} />
    </div>
  );
}

function Tile({ icon: Icon, title, value, detail, high, children }: { icon: typeof Cpu; title: string; value: string; detail: string; high: boolean; children: ReactNode }): ReactNode {
  return (
    <section className="panel flex min-w-0 flex-col gap-3 p-4" aria-label={title}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-dim">
          <Icon aria-hidden className="size-4" />
          {title}
        </h2>
        {high ? <HighBadge /> : null}
      </div>
      <div>
        <p className="num text-3xl font-bold leading-tight">{value}</p>
        <p className="hint">{detail}</p>
      </div>
      {children}
    </section>
  );
}

// Memory of the machine in three parts: game servers, everything else, free
function MemoryShare({ data, servers }: { data: UsageResponse; servers: number }): ReactNode {
  const { t } = useI18n();
  const u = t.usage;
  const total = data.host.totalMemoryBytes;
  const used = data.samples.at(-1)?.memoryUsedBytes ?? 0;
  const game = Math.min(servers, used);
  const other = Math.max(0, used - game);
  const parts = [
    { key: 'servers', label: u.shareServers, bytes: game, className: 'bg-accent' },
    { key: 'other', label: u.shareOther, bytes: other, className: 'bg-faint' },
    { key: 'free', label: u.shareFree, bytes: Math.max(0, total - used), className: 'bg-line' },
  ];
  return (
    <div className="space-y-2">
      <p className="label">{u.share}</p>
      <div className="flex h-3 gap-0.5 overflow-hidden rounded-full" role="img" aria-label={parts.map((part) => `${part.label}: ${formatBytes(part.bytes)}`).join(', ')}>
        {parts.map((part) =>
          part.bytes <= 0 ? null : <div key={part.key} className={cx('h-full first:rounded-l-full last:rounded-r-full', part.className)} style={{ width: `${(part.bytes / total) * 100}%` }} />,
        )}
      </div>
      <ul className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
        {parts.map((part) => (
          <li key={part.key} className="flex items-center gap-2">
            <span aria-hidden className={cx('size-2.5 rounded-full', part.className)} />
            <span className="text-dim">{part.label}</span>
            <span className="num font-semibold">{formatBytes(part.bytes)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ServerRow({ server, data }: { server: ServerView; data: UsageResponse }): ReactNode {
  const { t } = useI18n();
  const u = t.usage;
  const { nameOf } = useGames();
  const { statusFor } = useLive();
  const status = statusFor(server);
  const history = data.servers.find((entry) => entry.serverId === server.id)?.samples ?? [];
  const cpu: SparkPoint[] = history.map((point) => ({ at: point.at, value: point.cpuPercent }));
  const memory: SparkPoint[] = history.map((point) => ({ at: point.at, value: point.rssBytes }));
  const running = status.rssBytes !== null || status.cpuPercent !== null;
  const limited = LIMITED.has(server.game);
  const maxBytes = server.maxRamMb * MB;
  const hostBytes = data.host.totalMemoryBytes;
  // near its own limit (Java servers); a server without a limit is measured against the machine only
  const memoryHigh = limited && status.rssBytes !== null && status.rssBytes >= maxBytes * (HIGH / 100);
  const share = status.rssBytes === null || hostBytes === 0 ? null : (status.rssBytes / hostBytes) * 100;
  return (
    <li className="grid gap-x-6 gap-y-3 rounded-xl border border-line p-4 lg:grid-cols-[minmax(12rem,1fr)_minmax(0,1.3fr)_minmax(0,1.3fr)]">
      <div className="min-w-0 space-y-1">
        <Link to={serverPath(server.id)} className="block truncate font-semibold">
          {server.name}
        </Link>
        <p className="hint">{nameOf(server.game)}</p>
        <StatusChip server={server} status={status} />
      </div>
      {running || history.length > 0 ? (
        <>
          <div className="min-w-0 space-y-1">
            <p className="flex items-baseline justify-between gap-2">
              <span className="label">{u.serverCpu}</span>
              <span className="num font-semibold">{formatPercent(status.cpuPercent)}</span>
            </p>
            <Sparkline points={cpu} max={100} warnAt={HIGH} label={u.chartLabel(u.serverCpu, server.name)} format={formatPercent} />
          </div>
          <div className="min-w-0 space-y-1">
            <p className="flex flex-wrap items-baseline justify-between gap-x-2">
              <span className="label">{u.serverMemory}</span>
              <span className="flex items-baseline gap-2">
                {memoryHigh ? <HighBadge /> : null}
                <span className="num font-semibold">{status.rssBytes === null ? '–' : formatBytes(status.rssBytes)}</span>
                <span className="hint">{limited ? u.ofMax(formatBytes(maxBytes)) : share === null ? u.noLimit : u.ofMachine(formatPercent(share))}</span>
              </span>
            </p>
            {limited ? (
              <Sparkline points={memory} max={maxBytes} warnAt={maxBytes * (HIGH / 100)} label={u.chartLabel(u.serverMemory, server.name)} format={formatBytes} />
            ) : (
              <Sparkline points={memory} max={hostBytes} label={u.chartLabel(u.serverMemory, server.name)} format={formatBytes} />
            )}
            {limited ? null : <p className="hint">{u.noLimitHint}</p>}
          </div>
        </>
      ) : (
        <p className="hint self-center lg:col-span-2">{u.offline}</p>
      )}
    </li>
  );
}

export function UsagePage(): ReactNode {
  const { t } = useI18n();
  const u = t.usage;
  const { state } = useLive();
  const usage = useQuery((signal) => systemApi.usage(signal), []);
  const intervalMs = usage.data?.intervalMs ?? 5000;

  useEffect(() => {
    document.title = u.documentTitle;
  }, [u]);
  useEffect(() => {
    const timer = setInterval(usage.reload, intervalMs);
    return () => clearInterval(timer);
  }, [usage.reload, intervalMs]);

  const data = usage.data;
  if (data === undefined) {
    return usage.error !== null ? (
      <ErrorNotice error={usage.error} title={u.loadFailed} action={<Button size="sm" onClick={usage.reload}>{t.common.retry}</Button>} />
    ) : (
      <LoadingBlock />
    );
  }

  const host = data.host;
  const last = data.samples.at(-1);
  const cpuNow = [...data.samples].reverse().find((point) => point.cpuPercent !== null)?.cpuPercent ?? null;
  const memoryUsed = last?.memoryUsedBytes ?? 0;
  const memoryPercent = host.totalMemoryBytes === 0 ? 0 : (memoryUsed / host.totalMemoryBytes) * 100;
  const diskUsed = host.disk === null ? 0 : host.disk.totalBytes - host.disk.freeBytes;
  const diskPercent = host.disk === null || host.disk.totalBytes === 0 ? 0 : (diskUsed / host.disk.totalBytes) * 100;
  const servers = [...(state.servers ?? [])];
  // the busiest first: by memory now, then by name
  const rss = (server: ServerView): number => data.servers.find((entry) => entry.serverId === server.id)?.samples.at(-1)?.rssBytes ?? -1;
  servers.sort((a, b) => rss(b) - rss(a) || a.name.localeCompare(b.name));
  const serverMemory = data.servers.reduce((sum, entry) => sum + (entry.samples.at(-1)?.rssBytes ?? 0), 0);

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div className="space-y-1">
        <h1 className="text-2xl">{u.title}</h1>
        <p className="text-dim">{u.intro(Math.round((data.intervalMs * 120) / 60_000), Math.round(data.intervalMs / 1000))}</p>
      </div>
      {usage.error === null ? null : <ErrorNotice error={usage.error} title={u.loadFailed} />}

      <h2 className="sr-only">{u.host}</h2>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Tile icon={Cpu} title={u.cpu} value={cpuNow === null ? u.waiting : formatPercent(cpuNow)} detail={u.cpuDetail(host.cpuCount)} high={cpuNow !== null && cpuNow >= HIGH}>
          <Sparkline points={data.samples.map((point) => ({ at: point.at, value: point.cpuPercent }))} max={100} warnAt={HIGH} label={u.cpu} format={formatPercent} />
        </Tile>
        <Tile icon={MemoryStick} title={u.memory} value={formatPercent(memoryPercent)} detail={u.memoryDetail(formatBytes(memoryUsed), formatBytes(host.totalMemoryBytes))} high={memoryPercent >= HIGH}>
          <Sparkline points={data.samples.map((point) => ({ at: point.at, value: point.memoryUsedBytes }))} max={host.totalMemoryBytes} warnAt={host.totalMemoryBytes * (HIGH / 100)} label={u.memory} format={formatBytes} />
        </Tile>
        <Tile
          icon={HardDrive}
          title={u.disk}
          value={host.disk === null ? '–' : formatPercent(diskPercent)}
          detail={host.disk === null ? u.diskUnknown : u.diskDetail(formatBytes(host.disk.freeBytes), formatBytes(host.disk.totalBytes))}
          high={diskPercent >= HIGH}
        >
          {host.disk === null ? null : <Meter value={diskUsed} max={host.disk.totalBytes} label={u.disk} />}
        </Tile>
        <Tile icon={ServerIcon} title={u.system} value={formatDuration(host.uptimeSeconds * 1000)} detail={u.uptime} high={false}>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-faint">{u.load}</dt>
            <dd className="num text-right">{host.loadAverage === null ? '–' : host.loadAverage.join(' / ')}</dd>
            <dt className="text-faint">{u.app}</dt>
            <dd className="num text-right">{formatBytes(host.appMemoryBytes)}</dd>
          </dl>
          {host.cpuModel === null ? null : <p className="hint truncate" title={host.cpuModel}>{host.cpuModel}</p>}
          {host.loadAverage === null ? <p className="hint">{u.noLoad}</p> : null}
        </Tile>
      </div>

      <Section title={u.servers} description={u.serversIntro}>
        <div className="space-y-5">
          <MemoryShare data={data} servers={serverMemory} />
          {servers.length === 0 ? (
            <p className="hint">{u.noServers}</p>
          ) : (
            <ul className="space-y-3" aria-label={u.servers}>
              {servers.map((server) => (
                <ServerRow key={server.id} server={server} data={data} />
              ))}
            </ul>
          )}
        </div>
      </Section>
    </div>
  );
}
