import { ArrowRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { useI18n } from '../../i18n';
import { backupsApi, consoleApi } from '../../lib/endpoints';
import { formatBytes, formatDateTime, formatDuration, formatMb } from '../../lib/format';
import { Link, serverPath, type ServerTab } from '../../lib/router';
import type { RuntimeStatus, ServerView } from '../../lib/types';
import { useQuery } from '../../lib/useQuery';
import { useLive } from '../../live/LiveProvider';
import { CrashPanel } from './ConsoleTab';

const RECENT_LINES = 8;

function Stat({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="panel p-4">
      <p className="text-xs text-faint">{label}</p>
      <p className="num mt-1.5 truncate text-xl font-semibold text-ink">{children}</p>
    </div>
  );
}

// The first area of a server: a few numbers, what the server printed last, and the way to the other areas
export function OverviewTab({ server, status, modsTab }: { server: ServerView; status: RuntimeStatus; modsTab: ServerTab }): ReactNode {
  const { t } = useI18n();
  const s = t.server;
  const running = status.state === 'online' || status.state === 'starting';
  // read again whenever the server changes state, so the lines and the last backup stay current
  const lines = useQuery((signal) => consoleApi.history(server.id, RECENT_LINES, signal), [server.id, status.state]);
  const backups = useQuery((signal) => backupsApi.list(server.id, signal), [server.id, status.state]);
  const last = (backups.data?.backups ?? []).filter((backup) => backup.status === 'ok').sort((a, b) => Number(new Date(b.createdAt)) - Number(new Date(a.createdAt)))[0];
  const crash = useLive().state.crashes[server.id];
  const players = status.players.length > 0 ? status.players.length : (status.playerCount ?? 0);

  return (
    <div className="space-y-5">
      {status.state === 'crashed' ? <CrashPanel status={status} lastLines={crash?.lastLines ?? []} /> : null}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label={s.stats.players}>{running ? players : '–'}</Stat>
        <Stat label={s.stats.running}>{running && status.startedAt !== null ? formatDuration(Date.now() - status.startedAt) : s.stats.stopped}</Stat>
        <Stat label={s.stats.memory}>{status.rssBytes === null ? formatMb(server.maxRamMb) : s.stats.memoryOf(formatBytes(status.rssBytes), formatMb(server.maxRamMb))}</Stat>
        <Stat label={s.stats.lastBackup}>{last === undefined ? s.stats.noBackup : formatDateTime(last.createdAt)}</Stat>
      </div>

      <section aria-labelledby="recent-lines" className="panel overflow-hidden p-0">
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <h2 id="recent-lines" className="text-base">
            {s.recent}
          </h2>
          <Link to={serverPath(server.id, 'console')} className="text-sm no-underline">
            {s.openConsole}
          </Link>
        </div>
        {(lines.data?.lines ?? []).length === 0 ? (
          <p className="px-4 py-3 text-dim">{s.recentEmpty}</p>
        ) : (
          <pre className="num overflow-x-auto px-4 py-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-dim">{(lines.data?.lines ?? []).map((line) => line.text).join('\n')}</pre>
        )}
      </section>

      <section aria-labelledby="quick-actions" className="space-y-2">
        <h2 id="quick-actions" className="text-base">
          {s.quick}
        </h2>
        <div className="flex flex-wrap gap-2">
          {(
            [
              [s.quickBackup, 'backups'],
              [s.quickMods, modsTab],
              [s.quickImport, 'backups'],
              [s.quickSettings, 'config'],
            ] as const
          ).map(([label, tab]) => (
            <Link key={label} to={serverPath(server.id, tab)} className="btn no-underline">
              {label}
              <ArrowRight aria-hidden className="size-4" />
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
