import { Eraser } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button, ErrorNotice, LoadingBlock, Notice, Section, cx } from '../../components/ui';
import { modsApi } from '../../lib/endpoints';
import { useI18n } from '../../i18n';
import { formatBytes, formatDateTime, plural } from '../../lib/format';
import { useQuery } from '../../lib/useQuery';

interface Props {
  serverId: string;
  folder: string;
  // changes whenever the update results changed, to read the folder again
  version: number;
}

// The old files an update leaves behind: per mod only the newest N stay (setting MOD_BACKUP_KEEP).
export function ModBackups({ serverId, folder, version }: Props): ReactNode {
  const { t } = useI18n();
  const b = t.mods.backups;
  const list = useQuery((signal) => modsApi.backups(serverId, signal), [serverId, version]);
  const [cleaning, setCleaning] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [report, setReport] = useState<{ removed: number; freedBytes: number } | null>(null);

  const data = list.data;
  const removable = data?.backups.filter((entry) => entry.removable) ?? [];
  const removableBytes = removable.reduce((sum, entry) => sum + entry.sizeBytes, 0);

  const clean = async (): Promise<void> => {
    setCleaning(true);
    setError(null);
    try {
      setReport(await modsApi.cleanBackups(serverId));
      list.reload();
    } catch (cause) {
      setError(cause);
    } finally {
      setCleaning(false);
    }
  };

  return (
    <Section
      title={b.title}
      description={b.description(folder, data?.keep ?? 3)}
      action={
        <Button icon={Eraser} loading={cleaning} disabled={removable.length === 0} onClick={() => void clean()}>
          {b.clean}
        </Button>
      }
    >
      {list.loading && data === undefined ? (
        <LoadingBlock label={b.loading} />
      ) : list.error !== null && data === undefined ? (
        <ErrorNotice error={list.error} action={<Button size="sm" onClick={list.reload}>{t.common.retry}</Button>} />
      ) : data === undefined || data.backups.length === 0 ? (
        <p className="hint">{b.empty}</p>
      ) : (
        <div className="space-y-3">
          <p className="num text-sm" aria-label={b.totalLabel}>
            {b.summary(plural(data.backups.length, t.mods.fileOne, t.mods.fileMany), formatBytes(data.totalBytes))}
            {removable.length === 0 ? '' : b.removable(plural(removable.length, t.mods.fileOne, t.mods.fileMany), formatBytes(removableBytes))}
          </p>
          <ul className="divide-y divide-line" aria-label={b.listLabel}>
            {data.backups.map((entry) => (
              <li key={entry.fileName} className={cx('flex flex-wrap items-center gap-x-3 gap-y-1 py-2', entry.removable && 'text-dim')}>
                <span className="min-w-0 flex-1 basis-48 break-all font-mono text-xs">{entry.fileName}</span>
                <span className="text-sm">{entry.modName ?? b.unassigned}</span>
                <span className="num hint">{formatDateTime(entry.createdAt)}</span>
                <span className="num w-20 text-right text-sm">{formatBytes(entry.sizeBytes)}</span>
                {entry.removable ? <span className="chip chip-warn">{b.willClean}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      )}
      {error === null ? null : <ErrorNotice error={error} title={b.cleanFailed} className="mt-3" />}
      {report === null ? null : (
        <Notice tone="success" className="mt-3">
          {report.removed === 0 ? b.nothingToClean : b.cleaned(plural(report.removed, t.mods.fileOne, t.mods.fileMany), formatBytes(report.freedBytes))}
        </Notice>
      )}
    </Section>
  );
}
