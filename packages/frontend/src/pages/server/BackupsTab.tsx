import { Archive, Download, FileDown, HardDrive, History, Plus, RotateCcw, Save, Trash2, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Dialog } from '../../components/Dialog';
import { Button, ErrorNotice, Field, LoadingBlock, Notice, Section, Spinner, Toggle, cx } from '../../components/ui';
import { renderOptionalRef, renderRef, useI18n } from '../../i18n';
import { getCurrentDictionary } from '../../i18n/current';
import { backupsApi } from '../../lib/endpoints';
import { formatBytes, formatDateTime, plural } from '../../lib/format';
import type { BackupKind, BackupSchedule, BackupStatus, BackupView, RestoreView, RuntimeStatus, ServerView } from '../../lib/types';
import { useQuery } from '../../lib/useQuery';
import { useLive } from '../../live/LiveProvider';
import { GameWorldTools } from './GameWorldTools';
import { WorldTools } from './WorldTools';

const KIND_CHIP: Record<BackupKind, string> = { manual: 'chip-accent', auto: '', safety: 'chip-warn' };
const STATUS_CHIP: Record<BackupStatus, string> = { running: 'chip-busy', ok: 'chip-ok', failed: 'chip-bad' };

const INTERVAL_PRESETS = [1, 2, 3, 4, 6, 8, 12, 24, 48, 72, 168];

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

function BackupRow({ serverId, backup, locked, onRestore, onDelete, onExport }: { serverId: string; backup: BackupView; locked: boolean; onRestore: () => void; onDelete: () => void; onExport: (() => void) | null }): ReactNode {
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
            {onExport === null ? null : (
              <Button size="sm" icon={FileDown} title={r.exportTitle} onClick={onExport}>
                {r.exportAsWorld}
              </Button>
            )}
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

type ScheduleMode = BackupSchedule['mode'];
const MAX_TIMES = 24;
const EVERY_DAYS_OPTIONS = Array.from({ length: 30 }, (_, index) => index + 1);

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

// older servers answer without mode, times and everyDays
function modeOf(schedule: BackupSchedule): ScheduleMode {
  return schedule.mode ?? ((schedule.times ?? []).length > 0 ? 'times' : schedule.intervalHours !== null ? 'hours' : 'off');
}

const VALID_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function ScheduleSection({ server, schedule, autoCount, onSaved }: { server: ServerView; schedule: BackupSchedule; autoCount: number; onSaved: () => void }): ReactNode {
  const { t } = useI18n();
  const s = t.backups.schedule;
  const savedMode = modeOf(schedule);
  const savedTimes = schedule.times ?? [];
  const savedEveryDays = schedule.everyDays ?? 1;
  const [mode, setMode] = useState<ScheduleMode>(savedMode);
  const [interval, setIntervalHours] = useState<number>(schedule.intervalHours ?? 6);
  const [times, setTimes] = useState<string[]>(savedTimes.length > 0 ? savedTimes : ['03:00']);
  const [everyDays, setEveryDays] = useState<number>(savedEveryDays);
  const [keepText, setKeepText] = useState(String(schedule.keepLast));
  const [includeConfig, setIncludeConfig] = useState(schedule.includeConfig);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const timeZone = schedule.mode === 'times' && schedule.timeZone ? schedule.timeZone : browserTimeZone();
  useEffect(() => {
    setMode(savedMode);
    setIntervalHours(schedule.intervalHours ?? 6);
    setTimes(savedTimes.length > 0 ? savedTimes : ['03:00']);
    setEveryDays(savedEveryDays);
    setKeepText(String(schedule.keepLast));
    setIncludeConfig(schedule.includeConfig);
  }, [savedMode, schedule.intervalHours, savedTimes.join(','), savedEveryDays, schedule.keepLast, schedule.includeConfig]);

  const changed = (): void => setSaved(false);
  const keep = parseKeepLast(keepText);
  const cleanTimes = [...new Set(times)].sort();
  const timesValid = times.length > 0 && times.every((time) => VALID_TIME.test(time));
  const presets = !INTERVAL_PRESETS.includes(interval) ? [...INTERVAL_PRESETS, interval].sort((a, b) => a - b) : INTERVAL_PRESETS;

  const patch: Partial<BackupSchedule> = {};
  if (mode !== savedMode) patch.mode = mode;
  if (mode === 'hours' && (mode !== savedMode || interval !== schedule.intervalHours)) {
    patch.mode = 'hours';
    patch.intervalHours = interval;
  }
  if (mode === 'times' && timesValid && (mode !== savedMode || cleanTimes.join(',') !== savedTimes.join(',') || everyDays !== savedEveryDays)) {
    patch.mode = 'times';
    patch.times = cleanTimes;
    patch.everyDays = everyDays;
    patch.timeZone = timeZone;
  }
  if (keep !== null && keep !== schedule.keepLast) patch.keepLast = keep;
  if (includeConfig !== schedule.includeConfig) patch.includeConfig = includeConfig;
  const dirty = Object.keys(patch).length > 0;
  const invalid = keep === null || (mode === 'times' && !timesValid);
  // lowering the number deletes the oldest automatic backups when saving
  const doomed = keep !== null && keep < schedule.keepLast ? Math.max(0, autoCount - keep) : 0;

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
                value={mode}
                onChange={(event) => {
                  setMode(event.target.value as ScheduleMode);
                  changed();
                }}
              >
                <option value="off">{s.off}</option>
                <option value="hours">{s.modeHours}</option>
                <option value="times">{s.modeTimes}</option>
              </select>
            )}
          </Field>
          {mode === 'hours' ? (
            <Field label={s.interval}>
              {(props) => (
                <select
                  {...props}
                  className="input"
                  value={String(interval)}
                  onChange={(event) => {
                    setIntervalHours(Number(event.target.value));
                    changed();
                  }}
                >
                  {presets.map((hours) => (
                    <option key={hours} value={hours}>
                      {intervalLabel(hours)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          ) : null}
          {mode === 'times' ? (
            <Field label={s.repeat}>
              {(props) => (
                <select
                  {...props}
                  className="input"
                  value={String(everyDays)}
                  onChange={(event) => {
                    setEveryDays(Number(event.target.value));
                    changed();
                  }}
                >
                  {EVERY_DAYS_OPTIONS.map((days) => (
                    <option key={days} value={days}>
                      {days === 1 ? s.everyDay : s.everyDays(days)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          ) : null}
        </div>

        {mode === 'times' ? (
          <fieldset className="space-y-2">
            <legend className="label">{s.times}</legend>
            <ul className="flex flex-wrap gap-2">
              {times.map((time, index) => (
                <li key={index} className="flex items-center gap-1">
                  <input
                    className="input num w-28"
                    type="time"
                    aria-label={s.timeLabel(index + 1)}
                    aria-invalid={VALID_TIME.test(time) ? undefined : true}
                    value={time}
                    onChange={(event) => {
                      const next = [...times];
                      next[index] = event.target.value;
                      setTimes(next);
                      changed();
                    }}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={X}
                    iconOnly
                    aria-label={s.removeTime(time)}
                    title={s.removeTime(time)}
                    disabled={times.length === 1}
                    onClick={() => {
                      setTimes(times.filter((_, other) => other !== index));
                      changed();
                    }}
                  />
                </li>
              ))}
              {times.length < MAX_TIMES ? (
                <li>
                  <Button
                    size="sm"
                    icon={Plus}
                    onClick={() => {
                      setTimes([...times, '12:00']);
                      changed();
                    }}
                  >
                    {s.addTime}
                  </Button>
                </li>
              ) : null}
            </ul>
            <p className="hint">{timesValid ? s.timesHint(timeZone) : s.timesInvalid}</p>
          </fieldset>
        ) : null}

        <Field label={s.keep} hint={s.keepHint} error={keep === null ? s.keepInvalid : undefined}>
          {(props) => (
            <input
              {...props}
              className="input num w-28"
              inputMode="numeric"
              value={keepText}
              onChange={(event) => {
                setKeepText(event.target.value);
                changed();
              }}
            />
          )}
        </Field>
        {keep === 1 ? <Notice tone="info">{s.keepOne}</Notice> : null}
        {doomed > 0 ? <Notice tone="warn">{s.keepLowered(doomed)}</Notice> : null}

        {server.game !== 'minecraft' ? null : <Toggle
          checked={includeConfig}
          onChange={(value) => {
            setIncludeConfig(value);
            changed();
          }}
          label={s.includeConfig}
          description={s.includeConfigHint}
        />}
        {schedule.nextRunAt && !dirty ? <p className="hint">{s.next(formatDateTime(schedule.nextRunAt))}</p> : null}
        {error === null ? null : <ErrorNotice error={error} title={s.saveFailed} />}
        {saved ? <Notice tone="success">{s.saved}</Notice> : null}
        <Button type="submit" variant="primary" icon={Save} loading={saving} disabled={!dirty || invalid}>
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
  // other games have no safe "pause saving": their backups run while the server is stopped
  const minecraft = server.game === 'minecraft';
  const busyServer = status.state === 'preparing' || status.state === 'starting' || status.state === 'stopping' || (!minecraft && running);

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
          !minecraft
            ? m.descriptionOffline
            : running
              ? m.descriptionRunning
              : m.descriptionStopped
        }
        action={
          <Button variant="primary" icon={Archive} loading={creating || writing} disabled={busyServer} title={busyServer ? (!minecraft && running ? m.stopFirstTitle : m.busyTitle) : undefined} onClick={() => void create()}>
            {m.create}
          </Button>
        }
      >
        {!minecraft ? null : <label className="mb-3 flex cursor-pointer items-start gap-3">
          <input type="checkbox" checked={withConfig} onChange={(event) => setIncludeConfig(event.target.checked)} className="mt-1 size-5 shrink-0 accent-[var(--color-accent)]" />
          <span>
            {m.includeConfig} <span className="hint block">{m.includeConfigHint}</span>
          </span>
        </label>}
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
        <p className="panel flex items-center gap-3 p-4 text-dim">
          <Archive aria-hidden className="size-5 shrink-0 text-faint" />
          <span>
            <strong className="font-medium text-ink">{t.backups.list.emptyTitle}.</strong> {t.backups.list.emptyBody}
          </span>
        </p>
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

      {minecraft ? (
        <WorldTools server={server} status={status} exportBackup={exportTarget} onCloseBackupExport={() => setExportTarget(null)} />
      ) : (
        <GameWorldTools server={server} status={status} exportBackup={exportTarget} onCloseBackupExport={() => setExportTarget(null)} onImported={list.reload} />
      )}

      {data === undefined ? null : <ScheduleSection server={server} schedule={data.schedule} autoCount={data.backups.filter((entry) => entry.kind === 'auto' && entry.status === 'ok').length} onSaved={list.reload} />}

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
