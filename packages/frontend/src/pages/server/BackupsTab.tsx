import { Archive, Download, FileDown, HardDrive, History, RotateCcw, Save, Trash2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Dialog } from '../../components/Dialog';
import { Button, EmptyState, ErrorNotice, Field, LoadingBlock, Notice, Section, Spinner, Toggle, cx } from '../../components/ui';
import { renderOptionalRef, renderRef, useI18n } from '../../i18n';
import { getCurrentDictionary } from '../../i18n/current';
import { backupsApi } from '../../lib/endpoints';
import { formatBytes, formatDateTime, plural } from '../../lib/format';
import type { BackupKind, BackupSchedule, BackupStatus, BackupView, RestoreView, RuntimeStatus, ServerView } from '../../lib/types';
import { useQuery } from '../../lib/useQuery';
import { useLive } from '../../live/LiveProvider';
import { WorldTools } from './WorldTools';

const KIND_CHIP: Record<BackupKind, string> = { manual: 'chip-accent', auto: '', safety: 'chip-warn' };
const STATUS_CHIP: Record<BackupStatus, string> = { running: 'chip-busy', ok: 'chip-ok', failed: 'chip-bad' };

const INTERVAL_PRESETS = [1, 2, 3, 6, 12, 24, 48, 168];

// In the active language; call from a component that uses useI18n()
export const intervalLabel = (hours: number): string => {
  const { interval } = getCurrentDictionary().backups;
  return hours === 168 ? interval.week : hours === 24 ? interval.day : hours === 1 ? interval.hour : interval.every(hours);
};

// Parses the "keep last N" field; null while it is not a whole number between 1 and 100
export function parseKeepLast(text: string): number | null {
  if (!/^\d{1,3}$/.test(text.trim())) return null;
  const value = Number(text.trim());
  return value >= 1 && value <= 100 ? value : null;
}

function BackupRow({ serverId, backup, locked, onRestore, onDelete, onExport }: { serverId: string; backup: BackupView; locked: boolean; onRestore: () => void; onDelete: () => void; onExport: () => void }): ReactNode {
  const { t } = useI18n();
  const r = t.backups.row;
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3" data-testid="backup-row">
      <div className="min-w-0 flex-1 basis-60 space-y-1">
        <p className="flex flex-wrap items-center gap-2">
          <span className="num font-medium">{formatDateTime(backup.createdAt)}</span>
          <span className={cx('chip', KIND_CHIP[backup.kind])}>{t.backups.kind[backup.kind]}</span>
          <span className={cx('chip', STATUS_CHIP[backup.status])}>
            {backup.status === 'running' ? <Spinner className="size-3" /> : null}
            {t.backups.status[backup.status]}
          </span>
          {backup.includesConfig ? <span className="chip">{r.withConfig}</span> : null}
        </p>
        <p className="num text-sm text-dim">
          {backup.status === 'ok' ? formatBytes(backup.sizeBytes) : backup.status === 'running' ? r.creating : '–'}
          {backup.worlds.length === 0 ? '' : ` · ${backup.worlds.join(', ')}`}
        </p>
        {backup.error === null ? null : <p className="text-sm text-bad">{renderRef(backup.errorRef, t, backup.error)}</p>}
        {backup.note === null ? null : <p className="hint">{renderRef(backup.noteRef, t, backup.note)}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {backup.status === 'ok' ? (
          <>
            <a href={backupsApi.downloadUrl(serverId, backup.id)} download className="btn btn-sm no-underline" aria-label={r.downloadLabel(formatDateTime(backup.createdAt))}>
              <Download aria-hidden className="size-4 shrink-0" />
              {r.download}
            </a>
            <Button size="sm" icon={FileDown} title={r.exportTitle} onClick={onExport}>
              {r.exportAsWorld}
            </Button>
            <Button size="sm" icon={RotateCcw} disabled={locked} title={locked ? r.restoreLocked : r.restoreTitle} onClick={onRestore}>
              {r.restore}
            </Button>
          </>
        ) : null}
        <Button size="sm" variant="danger" icon={Trash2} disabled={backup.status === 'running'} onClick={onDelete}>
          {r.delete}
        </Button>
      </div>
    </li>
  );
}

function ScheduleSection({ server, schedule, onSaved }: { server: ServerView; schedule: BackupSchedule; onSaved: () => void }): ReactNode {
  const { t } = useI18n();
  const s = t.backups.schedule;
  const [interval, setIntervalHours] = useState<number | null>(schedule.intervalHours);
  const [keepText, setKeepText] = useState(String(schedule.keepLast));
  const [includeConfig, setIncludeConfig] = useState(schedule.includeConfig);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    setIntervalHours(schedule.intervalHours);
    setKeepText(String(schedule.keepLast));
    setIncludeConfig(schedule.includeConfig);
  }, [schedule.intervalHours, schedule.keepLast, schedule.includeConfig]);

  const keep = parseKeepLast(keepText);
  const presets = interval !== null && !INTERVAL_PRESETS.includes(interval) ? [...INTERVAL_PRESETS, interval].sort((a, b) => a - b) : INTERVAL_PRESETS;
  const patch: Partial<BackupSchedule> = {};
  if (interval !== schedule.intervalHours) patch.intervalHours = interval;
  if (keep !== null && keep !== schedule.keepLast) patch.keepLast = keep;
  if (includeConfig !== schedule.includeConfig) patch.includeConfig = includeConfig;
  const dirty = Object.keys(patch).length > 0;

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      await backupsApi.setSchedule(server.id, patch);
      setSaved(true);
      onSaved();
    } catch (cause) {
      setError(cause);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section title={s.title} description={s.description}>
      <form
        className="space-y-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={s.auto}>
            {(props) => (
              <select
                {...props}
                className="input"
                value={interval === null ? '' : String(interval)}
                onChange={(event) => {
                  setIntervalHours(event.target.value === '' ? null : Number(event.target.value));
                  setSaved(false);
                }}
              >
                <option value="">{s.off}</option>
                {presets.map((hours) => (
                  <option key={hours} value={hours}>
                    {intervalLabel(hours)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label={s.keep} hint={s.keepHint} error={keep === null ? s.keepInvalid : undefined}>
            {(props) => (
              <input
                {...props}
                className="input num"
                inputMode="numeric"
                value={keepText}
                onChange={(event) => {
                  setKeepText(event.target.value);
                  setSaved(false);
                }}
              />
            )}
          </Field>
        </div>
        <Toggle
          checked={includeConfig}
          onChange={(value) => {
            setIncludeConfig(value);
            setSaved(false);
          }}
          label={s.includeConfig}
          description={s.includeConfigHint}
        />
        {error === null ? null : <ErrorNotice error={error} title={s.saveFailed} />}
        {saved ? <Notice tone="success">{s.saved}</Notice> : null}
        <Button type="submit" variant="primary" icon={Save} loading={saving} disabled={!dirty || keep === null}>
          {s.save}
        </Button>
      </form>
    </Section>
  );
}

export function BackupsTab({ server, status }: { server: ServerView; status: RuntimeStatus }): ReactNode {
  const { t } = useI18n();
  const m = t.backups.main;
  const { state } = useLive();
  const tick = state.backupTicks[server.id] ?? 0;
  const list = useQuery((signal) => backupsApi.list(server.id, signal), [server.id, tick]);
  const [includeConfig, setIncludeConfig] = useState<boolean | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [restoreTarget, setRestoreTarget] = useState<BackupView | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<unknown>(null);
  const [restored, setRestored] = useState<RestoreView | null>(null);
  const [exportTarget, setExportTarget] = useState<BackupView | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BackupView | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<unknown>(null);

  const data = list.data;
  const backups = data?.backups ?? [];
  const running = status.state === 'preparing' || status.state === 'starting' || status.state === 'online' || status.state === 'stopping';
  const writing = data?.running === true || backups.some((backup) => backup.status === 'running');
  const withConfig = includeConfig ?? data?.schedule.includeConfig ?? false;
  const busyServer = status.state === 'preparing' || status.state === 'starting' || status.state === 'stopping';

  const create = async (): Promise<void> => {
    setCreating(true);
    setError(null);
    try {
      await backupsApi.create(server.id, withConfig);
      list.reload();
    } catch (cause) {
      setError(cause);
    } finally {
      setCreating(false);
    }
  };

  const restore = async (): Promise<void> => {
    if (restoreTarget === null) return;
    setRestoring(true);
    setRestoreError(null);
    try {
      setRestored(await backupsApi.restore(server.id, restoreTarget.id));
      setRestoreTarget(null);
      list.reload();
    } catch (cause) {
      setRestoreError(cause);
    } finally {
      setRestoring(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (deleteTarget === null) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await backupsApi.remove(server.id, deleteTarget.id);
      setDeleteTarget(null);
      list.reload();
    } catch (cause) {
      setDeleteError(cause);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-4">
      <Section
        title={m.title}
        description={
          running
            ? m.descriptionRunning
            : m.descriptionStopped
        }
        action={
          <Button variant="primary" icon={Archive} loading={creating || writing} disabled={busyServer} title={busyServer ? m.busyTitle : undefined} onClick={() => void create()}>
            {m.create}
          </Button>
        }
      >
        <label className="mb-3 flex cursor-pointer items-start gap-3">
          <input type="checkbox" checked={withConfig} onChange={(event) => setIncludeConfig(event.target.checked)} className="mt-1 size-5 shrink-0 accent-[var(--color-accent)]" />
          <span>
            {m.includeConfig} <span className="hint block">{m.includeConfigHint}</span>
          </span>
        </label>
        {error === null ? null : <ErrorNotice error={error} title={m.createFailed} />}
        {data === undefined ? null : (
          <p className="num hint flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="inline-flex items-center gap-1.5">
              <History aria-hidden className="size-3.5" />
              {m.summary(plural(backups.length, m.backupOne, m.backupMany), formatBytes(data.totalBytes))}
            </span>
            {data.freeBytes === null ? null : (
              <span className="inline-flex items-center gap-1.5">
                <HardDrive aria-hidden className="size-3.5" />
                {m.free(formatBytes(data.freeBytes))}
              </span>
            )}
          </p>
        )}
      </Section>

      {restored === null ? null : (
        <Notice
          tone={restored.warnings.length > 0 ? 'warn' : 'success'}
          title={t.backups.restored.title}
          action={<Button size="sm" variant="ghost" onClick={() => setRestored(null)}>{t.backups.restored.hide}</Button>}
        >
          <p>{t.backups.restored.before(restored.safety === null ? t.backups.restored.safetyNone : t.backups.restored.safetyMade)}</p>
          {restored.warnings.length === 0 ? null : (
            <ul className="mt-1 list-disc pl-5">
              {restored.warnings.map((warning, index) => (
                <li key={`${index}-${warning}`}>{renderOptionalRef(restored.warningRefs?.[index], t, warning)}</li>
              ))}
            </ul>
          )}
        </Notice>
      )}

      {list.loading && data === undefined ? (
        <LoadingBlock label={t.backups.list.loading} />
      ) : list.error !== null && data === undefined ? (
        <ErrorNotice error={list.error} title={t.backups.list.loadFailed} action={<Button size="sm" onClick={list.reload}>{t.common.retry}</Button>} />
      ) : backups.length === 0 ? (
        <EmptyState icon={Archive} title={t.backups.list.emptyTitle}>
          <p>{t.backups.list.emptyBody}</p>
        </EmptyState>
      ) : (
        <section aria-label={t.backups.list.label} className="panel overflow-hidden">
          <ul className="divide-y divide-line">
            {backups.map((backup) => (
              <BackupRow
                key={backup.id}
                serverId={server.id}
                backup={backup}
                locked={running}
                onRestore={() => {
                  setRestoreError(null);
                  setRestoreTarget(backup);
                }}
                onDelete={() => {
                  setDeleteError(null);
                  setDeleteTarget(backup);
                }}
                onExport={() => setExportTarget(backup)}
              />
            ))}
          </ul>
        </section>
      )}

      <WorldTools server={server} status={status} exportBackup={exportTarget} onCloseBackupExport={() => setExportTarget(null)} />

      {data === undefined ? null : <ScheduleSection server={server} schedule={data.schedule} onSaved={list.reload} />}

      <Dialog
        open={restoreTarget !== null}
        title={t.backups.restoreDialog.title}
        onClose={() => setRestoreTarget(null)}
        footer={
          <>
            <Button onClick={() => setRestoreTarget(null)}>{t.common.cancel}</Button>
            <Button variant="danger-solid" icon={RotateCcw} loading={restoring} disabled={running} onClick={() => void restore()}>
              {t.backups.restoreDialog.confirm}
            </Button>
          </>
        }
      >
        <Notice tone="warn" title={t.backups.restoreDialog.noticeTitle}>
          {t.backups.restoreDialog.notice(restoreTarget === null ? '' : formatDateTime(restoreTarget.createdAt), restoreTarget?.includesConfig === true)}
        </Notice>
        {running ? <Notice tone="error">{t.backups.restoreDialog.serverRunning}</Notice> : null}
        {restoreError === null ? null : <ErrorNotice error={restoreError} />}
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        title={t.backups.deleteDialog.title}
        onClose={() => setDeleteTarget(null)}
        footer={
          <>
            <Button onClick={() => setDeleteTarget(null)}>{t.common.cancel}</Button>
            <Button variant="danger-solid" icon={Trash2} loading={deleting} onClick={() => void remove()}>
              {t.backups.deleteDialog.confirm}
            </Button>
          </>
        }
      >
        <p>{t.backups.deleteDialog.body(deleteTarget === null ? '' : formatDateTime(deleteTarget.createdAt), deleteTarget === null ? '' : t.backups.kind[deleteTarget.kind])}</p>
        {deleteError === null ? null : <ErrorNotice error={deleteError} />}
      </Dialog>
    </div>
  );
}
