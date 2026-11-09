import { ArrowUpCircle, History, PackageX, ScanSearch, Trash2 } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Dialog } from '../../components/Dialog';
import { Button, EmptyState, ErrorNotice, LoadingBlock, Notice, Section, Switch, cx } from '../../components/ui';
import type { MessageRef } from '@worldfoundry/backend/contract';
import { modsApi } from '../../lib/endpoints';
import { renderOptionalRef, useI18n } from '../../i18n';
import { getCurrentDictionary } from '../../i18n/current';
import { formatBytes, formatDateTime, plural } from '../../lib/format';
import { Link, serverPath } from '../../lib/router';
import type { ModLogEntry, ModView, RuntimeStatus, ScanAndUpdates, ServerView, UpdateResult } from '../../lib/types';
import { useQuery } from '../../lib/useQuery';
import { useLive } from '../../live/LiveProvider';
import { ModBackups } from './ModBackups';
import { useModRemoval } from './useModRemoval';
import { useModToggle } from './useModToggle';

// Wording of the content type (Mods or Plugins) in the active language; call from a component that uses useI18n()
export const contentNames = (server: Pick<ServerView, 'loader'>): { singular: string; plural: string; store: string } => {
  const { content } = getCurrentDictionary().mods;
  return server.loader === 'paper' ? content.plugin : content.mod;
};

export function isLocked(status: Pick<RuntimeStatus, 'state'>): boolean {
  return status.state === 'preparing' || status.state === 'starting' || status.state === 'online' || status.state === 'stopping';
}

// The backend's warning for a dependency that was switched on together with a mod (mods/toggle.ts). Those dependencies are listed on their own, so the warning is not repeated.
const DEPENDENCY_WARNING = /as a required dependency/i;
// With the warning's reference the key decides (MOD_DEPENDENCY_ENABLED); the text is matched only when there is no reference
export const isDependencyWarning = (warning: string, ref?: MessageRef | null): boolean =>
  ref === undefined || ref === null ? DEPENDENCY_WARNING.test(warning) : ref.key === 'MOD_DEPENDENCY_ENABLED';

export type ModFilter = 'all' | 'enabled' | 'disabled';

export const FILTER_KEYS: readonly ModFilter[] = ['all', 'enabled', 'disabled'];

export const matchesFilter = (mod: Pick<ModView, 'enabled'>, filter: ModFilter): boolean => filter === 'all' || (filter === 'enabled') === mod.enabled;

export function NoModsSupport({ server }: { server: ServerView }): ReactNode {
  const { t } = useI18n();
  return (
    <EmptyState icon={PackageX} title={t.mods.noSupport.title}>
      <p>{t.mods.noSupport.body(server.name)}</p>
    </EmptyState>
  );
}

export function RunningLock({ server, what }: { server: ServerView; what: string }): ReactNode {
  const { t } = useI18n();
  return (
    <Notice tone="warn" title={t.mods.runningLock.title(what)}>
      {t.mods.runningLock.before(server.name)}{' '}
      <Link to={serverPath(server.id)}>{t.mods.runningLock.stopLink}</Link>.
    </Notice>
  );
}

const STATUS_CHIP: Record<UpdateResult['status'], string> = { success: 'chip-ok', failed: 'chip-bad', rolled_back: 'chip-warn' };

interface RowProps {
  mod: ModView;
  locked: boolean;
  update: boolean;
  busy: boolean;
  onDelete: () => void;
  onToggle: (enabled: boolean) => void;
  names: ReturnType<typeof contentNames>;
}

function ModRow({ mod, locked, update, busy, onDelete, onToggle, names }: RowProps): ReactNode {
  const { t } = useI18n();
  const r = t.mods.row;
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3" data-enabled={mod.enabled}>
      <Switch
        checked={mod.enabled}
        onChange={onToggle}
        label={mod.enabled ? r.disableLabel(mod.name) : r.enableLabel(mod.name)}
        disabled={locked || busy}
        title={locked ? r.lockedOnlyStopped : mod.enabled ? r.disableTitle(names.singular) : r.enableTitle(names.singular)}
      />
      <div className={cx('min-w-0 flex-1 basis-44', !mod.enabled && 'opacity-60')}>
        <p className="flex flex-wrap items-center gap-2 font-medium">
          <span className="min-w-0 break-words">{mod.name}</span>
          {mod.enabled ? null : <span className="chip chip-warn">{r.disabledChip}</span>}
          {update ? <span className="chip chip-accent">{r.updateAvailable}</span> : null}
        </p>
        <p className="num text-sm text-dim">
          {mod.versionNumber === null ? r.versionUnknown : r.version(mod.versionNumber)} · <span className="font-mono text-xs">{mod.fileName}</span>
        </p>
      </div>
      <div className={cx('flex flex-wrap items-center gap-2', !mod.enabled && 'opacity-60')}>
        <span className={cx('chip', mod.source === 'modrinth' ? 'chip-accent' : '')}>{mod.source === 'modrinth' ? r.sourceModrinth : r.sourceManual}</span>
        <span className="num hint">{formatBytes(mod.sizeBytes)}</span>
        <Button size="sm" variant="danger" icon={Trash2} disabled={locked} title={locked ? r.removeLocked : r.removeTitle(names.singular)} onClick={onDelete}>
          {r.remove}
        </Button>
      </div>
    </li>
  );
}

function ModGroup({ title, description, mods, ...rest }: { title: string; description: string; mods: ModView[]; locked: boolean; updates: Set<string>; busyId: string | null; onDelete: (mod: ModView) => void; onToggle: (mod: ModView, enabled: boolean) => void; names: ReturnType<typeof contentNames> }): ReactNode {
  if (mods.length === 0) return null;
  return (
    <section aria-label={title} className="panel overflow-hidden">
      <div className="border-b border-line px-4 py-3">
        <h3 className="text-base">
          {title} <span className="num text-dim">({mods.length})</span>
        </h3>
        <p className="hint">{description}</p>
      </div>
      <ul className="divide-y divide-line">
        {mods.map((mod) => (
          <ModRow key={mod.id} mod={mod} locked={rest.locked} busy={rest.busyId === mod.id} update={mod.projectId !== null && rest.updates.has(mod.projectId)} names={rest.names} onDelete={() => rest.onDelete(mod)} onToggle={(enabled) => rest.onToggle(mod, enabled)} />
        ))}
      </ul>
    </section>
  );
}

function UpdateLog({ serverId }: { serverId: string }): ReactNode {
  const { t } = useI18n();
  const log = useQuery((signal) => modsApi.updateLog(serverId, 50, signal), [serverId]);
  if (log.loading) return <LoadingBlock label={t.mods.log.loading} />;
  if (log.error !== null) return <ErrorNotice error={log.error} action={<Button size="sm" onClick={log.reload}>{t.common.retry}</Button>} />;
  const entries: ModLogEntry[] = log.data ?? [];
  if (entries.length === 0) return <p className="hint">{t.mods.log.empty}</p>;
  return (
    <ul className="divide-y divide-line">
      {entries.map((entry) => (
        <li key={entry.id} className="space-y-0.5 py-2">
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{entry.modName}</span>
            <span className={cx('chip', STATUS_CHIP[entry.status])}>{t.mods.status[entry.status]}</span>
            <span className="num hint">{formatDateTime(entry.createdAt)}</span>
          </p>
          <p className="font-mono text-xs text-dim">
            {entry.fromFileName ?? '?'} → {entry.toFileName ?? '?'}
          </p>
          {entry.error === null ? null : <p className="text-sm text-bad">{renderOptionalRef(entry.errorRef, t, entry.error)}</p>}
        </li>
      ))}
    </ul>
  );
}

export function ModsTab({ server, status }: { server: ServerView; status: RuntimeStatus }): ReactNode {
  const { t } = useI18n();
  const names = contentNames(server);
  const locked = isLocked(status);
  const { state } = useLive();
  const supported = server.loader !== 'vanilla';
  const list = useQuery((signal) => modsApi.list(server.id, signal), [server.id], supported);
  const removal = useModRemoval(server.id, list.reload);
  const switcher = useModToggle(server.id, list.reload);
  const [filter, setFilter] = useState<ModFilter>('all');
  const [backupVersion, setBackupVersion] = useState(0);

  const [busy, setBusy] = useState<'scan' | 'check' | 'apply' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [scanInfo, setScanInfo] = useState<ScanAndUpdates | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<UpdateResult[] | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [checked, setChecked] = useState(false);

  const updates = scanInfo?.updates ?? [];
  const updateProjects = useMemo(() => new Set(updates.map((update) => update.projectId)), [updates]);
  const mods = list.data ?? [];
  const shown = mods.filter((mod) => matchesFilter(mod, filter));
  const disabledCount = mods.filter((mod) => !mod.enabled).length;
  const direct = shown.filter((mod) => mod.source === 'modrinth' && !mod.isDependency);
  const dependencies = shown.filter((mod) => mod.source === 'modrinth' && mod.isDependency);
  const manual = shown.filter((mod) => mod.source !== 'modrinth');
  const liveUpdates = state.modUpdates[server.id];

  if (!supported) return <NoModsSupport server={server} />;

  const run = async (kind: 'scan' | 'check' | 'apply', action: () => Promise<void>): Promise<void> => {
    setBusy(kind);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(null);
    }
  };

  const scan = (): Promise<void> =>
    run('scan', async () => {
      const report = await modsApi.scan(server.id);
      setScanInfo({ updates: scanInfo?.updates ?? [], scan: report });
      list.reload();
    });
  const check = (): Promise<void> =>
    run('check', async () => {
      const found = await modsApi.checkUpdates(server.id);
      setScanInfo(found);
      setChecked(true);
      setSelected(new Set(found.updates.map((update) => update.projectId)));
      setResults(null);
      list.reload();
    });
  const apply = (projectIds?: string[]): Promise<void> =>
    run('apply', async () => {
      const applied = await modsApi.applyUpdates(server.id, projectIds);
      setResults(applied.results);
      setScanInfo((current) => (current === null ? null : { ...current, updates: current.updates.filter((update) => !applied.results.some((result) => result.modId === update.modId && result.status === 'success')) }));
      setBackupVersion((value) => value + 1);
      list.reload();
    });

  const toggle = (projectId: string): void =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });

  return (
    <div className="space-y-4">
      {locked ? <RunningLock server={server} what={names.plural} /> : null}

      {liveUpdates === undefined || !liveUpdates.ok || liveUpdates.count === 0 ? null : (
        <Notice tone="info" title={t.mods.live.available(plural(liveUpdates.count, t.mods.updateOne, t.mods.updateMany))} action={<Button size="sm" onClick={() => void check()} disabled={busy !== null}>{t.mods.live.checkNow}</Button>}>
          {t.mods.live.body(liveUpdates.projects.join(', '))}
        </Notice>
      )}
      {liveUpdates !== undefined && !liveUpdates.ok ? <Notice tone="warn">{t.mods.live.failed(renderOptionalRef(liveUpdates.errorRef, t, liveUpdates.error) ?? null)}</Notice> : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button icon={ScanSearch} loading={busy === 'scan'} disabled={busy !== null} onClick={() => void scan()}>
          {t.mods.actions.scan}
        </Button>
        <Button icon={ArrowUpCircle} loading={busy === 'check'} disabled={busy !== null} onClick={() => void check()}>
          {t.mods.actions.check}
        </Button>
        <Button variant="ghost" icon={History} aria-expanded={showLog} onClick={() => setShowLog((value) => !value)}>
          {t.mods.actions.log}
        </Button>
        <Link to={serverPath(server.id, 'store')} className="link-btn ml-auto">
          {t.mods.actions.toStore(names.store)}
        </Link>
      </div>

      {error === null ? null : <ErrorNotice error={error} />}
      {switcher.error === null ? null : <ErrorNotice error={switcher.error} title={t.mods.toggleFailedTitle(names.singular)} />}

      {scanInfo === null ? null : (
        <Notice tone={scanInfo.scan.modrinthAvailable ? 'success' : 'warn'} title={t.mods.scan.title}>
          <p className="num">{t.mods.scan.summary({ files: plural(scanInfo.scan.scanned, t.mods.fileOne, t.mods.fileMany), added: scanInfo.scan.added, removed: scanInfo.scan.removed, renamed: scanInfo.scan.renamed, replaced: scanInfo.scan.replaced, toggled: scanInfo.scan.toggled, identified: scanInfo.scan.identified })}</p>
          {scanInfo.scan.warnings.length === 0 ? null : (
            <ul className="mt-1 list-disc pl-5">
              {scanInfo.scan.warnings.map((warning, index) => (
                <li key={`${index}-${warning}`}>{renderOptionalRef(scanInfo.scan.warningRefs?.[index], t, warning)}</li>
              ))}
            </ul>
          )}
        </Notice>
      )}

      {checked && updates.length === 0 && results === null && busy === null ? <Notice tone="success">{t.mods.upToDate(names.plural)}</Notice> : null}

      {updates.length === 0 ? null : (
        <Section
          title={t.mods.live.available(plural(updates.length, t.mods.updateOne, t.mods.updateMany))}
          description={t.mods.updates.description}
          action={
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" icon={ArrowUpCircle} disabled={busy !== null || locked || selected.size === 0} loading={busy === 'apply'} onClick={() => void apply([...selected])}>
                {t.mods.updates.applySelected(selected.size)}
              </Button>
              <Button disabled={busy !== null || locked} onClick={() => void apply()}>
                {t.mods.updates.applyAll}
              </Button>
            </div>
          }
        >
          <ul className="divide-y divide-line">
            {updates.map((update) => (
              <li key={update.modId} className="py-2">
                <label className="flex cursor-pointer items-start gap-3">
                  <input type="checkbox" checked={selected.has(update.projectId)} onChange={() => toggle(update.projectId)} className="mt-1 size-5 shrink-0 accent-[var(--color-accent)]" />
                  <span className="min-w-0">
                    <span className="block font-medium">{update.name}</span>
                    <span className="num block text-sm text-dim">
                      {update.currentVersionNumber} → {update.newVersionNumber} {update.versionType === 'release' ? '' : `(${update.versionType})`}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {results === null ? null : (
        <Section title={t.mods.updates.resultsTitle}>
          <ul className="divide-y divide-line" aria-label={t.mods.updates.resultsLabel}>
            {results.length === 0 ? <li className="py-2 text-dim">{t.mods.updates.nothingToUpdate}</li> : null}
            {results.map((result) => (
              <li key={result.modId} className="space-y-0.5 py-2">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{result.name}</span>
                  <span className={cx('chip', STATUS_CHIP[result.status])}>{t.mods.status[result.status]}</span>
                </p>
                {result.error === undefined ? null : <p className="text-sm text-bad">{renderOptionalRef(result.errorRef, t, result.error)}</p>}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {showLog ? (
        <Section title={t.mods.log.title} description={t.mods.log.description}>
          <UpdateLog serverId={server.id} />
        </Section>
      ) : null}

      {switcher.result === null ? null : (
        <Notice
          tone={switcher.result.data.warnings.length > 0 || switcher.result.data.dependencies.length > 0 ? 'warn' : 'success'}
          title={
            switcher.result.data.changed.length === 0
              ? t.mods.toggled.already(switcher.result.data.mod.name, switcher.result.enabled)
              : t.mods.toggled.now(switcher.result.data.mod.name, switcher.result.enabled)
          }
          action={<Button size="sm" variant="ghost" onClick={switcher.dismissResult}>{t.mods.toggled.hide}</Button>}
        >
          {switcher.result.data.dependencies.length === 0 ? null : (
            <>
              <p>{t.mods.toggled.dependenciesEnabled}</p>
              <ul className="mt-1 list-disc pl-5" aria-label={t.mods.toggled.dependenciesLabel}>
                {switcher.result.data.dependencies.map((dependency) => (
                  <li key={dependency.id} className="font-medium text-ink">
                    {dependency.name}
                  </li>
                ))}
              </ul>
            </>
          )}
          {switcher.result.data.warnings
            .map((warning, index) => ({ warning, ref: switcher.result?.data.warningRefs?.[index] ?? null }))
            .filter(({ warning, ref }) => !isDependencyWarning(warning, ref))
            .map(({ warning, ref }, index) => (
              <p key={`${index}-${warning}`}>{renderOptionalRef(ref, t, warning)}</p>
            ))}
        </Notice>
      )}

      {removal.result === null ? null : (
        <Notice
          tone={removal.result.orphaned.length > 0 ? 'warn' : 'success'}
          title={t.mods.removed.title(removal.result.removed.name)}
          action={<Button size="sm" variant="ghost" onClick={removal.dismissResult}>{t.mods.toggled.hide}</Button>}
        >
          {removal.result.orphaned.length === 0 ? null : (
            <>
              <p>{t.mods.removed.orphaned(names.singular)}</p>
              <ul className="mt-1 space-y-1">
                {removal.result.orphaned.map((orphan) => {
                  const current = mods.find((mod) => mod.id === orphan.id);
                  return (
                    <li key={orphan.id} className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-ink">{orphan.name}</span>
                      {current === undefined ? null : (
                        <Button size="sm" variant="danger" icon={Trash2} disabled={locked} onClick={() => removal.open(current)}>
                          {t.mods.row.remove}
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </Notice>
      )}

      {list.loading && list.data === undefined ? (
        <LoadingBlock label={t.mods.list.loading(names.plural)} />
      ) : list.error !== null && list.data === undefined ? (
        <ErrorNotice error={list.error} title={t.mods.list.loadFailed(names.plural)} action={<Button size="sm" onClick={list.reload}>{t.common.retry}</Button>} />
      ) : mods.length === 0 ? (
        <EmptyState icon={PackageX} title={t.mods.list.emptyTitle(names.plural)} action={<Link to={serverPath(server.id, 'store')} className="link-btn">{t.mods.list.searchInStore(names.store)}</Link>}>
          <p>{t.mods.list.emptyBody}</p>
        </EmptyState>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <div role="group" aria-label={t.mods.list.filterLabel(names.plural)} className="flex flex-wrap gap-1.5">
              {FILTER_KEYS.map((key) => (
                <button key={key} type="button" aria-pressed={filter === key} onClick={() => setFilter(key)} className="chip min-h-9 cursor-pointer px-3 aria-pressed:border-accent aria-pressed:text-ink">
                  {t.mods.filter[key]}
                  <span className="num text-dim">{key === 'all' ? mods.length : key === 'enabled' ? mods.length - disabledCount : disabledCount}</span>
                </button>
              ))}
            </div>
            <p className="hint min-w-0 flex-1 basis-64">
              {t.mods.list.disabledHint}
            </p>
          </div>
          {shown.length === 0 ? <p className="hint">{t.mods.list.noEntries}</p> : null}
          <ModGroup title={t.mods.groups.direct(names.plural)} description={t.mods.groups.directDesc(names.plural)} mods={direct} locked={locked} updates={updateProjects} busyId={switcher.busyId} names={names} onDelete={removal.open} onToggle={(mod, enabled) => void switcher.toggle(mod, enabled)} />
          <ModGroup title={t.mods.groups.dependencies} description={t.mods.groups.dependenciesDesc(names.plural)} mods={dependencies} locked={locked} updates={updateProjects} busyId={switcher.busyId} names={names} onDelete={removal.open} onToggle={(mod, enabled) => void switcher.toggle(mod, enabled)} />
          <ModGroup title={t.mods.groups.manual} description={t.mods.groups.manualDesc} mods={manual} locked={locked} updates={updateProjects} busyId={switcher.busyId} names={names} onDelete={removal.open} onToggle={(mod, enabled) => void switcher.toggle(mod, enabled)} />
        </div>
      )}

      <ModBackups serverId={server.id} folder={server.loader === 'paper' ? 'plugins_backup' : 'mods_backup'} version={backupVersion} />

      <Dialog
        open={switcher.pending !== null}
        title={t.mods.dialogs.neededTitle(switcher.pending?.name ?? '')}
        onClose={switcher.cancel}
        footer={
          <>
            <Button onClick={switcher.cancel}>{t.common.cancel}</Button>
            <Button variant="danger-solid" loading={switcher.busyId !== null} onClick={() => void switcher.confirmForce()}>
              {t.mods.dialogs.forceDisable}
            </Button>
          </>
        }
      >
        <Notice tone="warn" title={t.mods.dialogs.disableNeededBy}>
          {t.mods.dialogs.disableNeededByBody}
        </Notice>
        <ul className="list-disc space-y-0.5 pl-5" aria-label={t.mods.dialogs.affected}>
          {switcher.dependents.map((dependent) => (
            <li key={dependent.id}>{dependent.name}</li>
          ))}
        </ul>
      </Dialog>

      <Dialog
        open={removal.target !== null}
        title={removal.phase === 'dependents' ? t.mods.dialogs.neededTitle(removal.target?.name ?? '') : t.mods.dialogs.removeTitle(names.singular)}
        onClose={removal.cancel}
        footer={
          <>
            <Button onClick={removal.cancel}>{t.common.cancel}</Button>
            <Button variant="danger-solid" icon={Trash2} loading={removal.busy} onClick={() => void removal.confirm()}>
              {removal.phase === 'dependents' ? t.mods.dialogs.forceRemove : t.mods.row.remove}
            </Button>
          </>
        }
      >
        {removal.phase === 'dependents' ? (
          <>
            <Notice tone="warn" title={t.mods.dialogs.removeNeededBy}>
              {t.mods.dialogs.removeNeededByBody}
            </Notice>
            <ul className="list-disc space-y-0.5 pl-5" aria-label={t.mods.dialogs.affected}>
              {removal.dependents.map((dependent) => (
                <li key={dependent.id}>{dependent.name}</li>
              ))}
            </ul>
          </>
        ) : (
          <p>
            {t.mods.dialogs.fileBefore}
            <span className="font-mono text-sm">{removal.target?.fileName}</span>
            {t.mods.dialogs.fileAfter}
          </p>
        )}
        {removal.error === null ? null : <ErrorNotice error={removal.error} />}
      </Dialog>
    </div>
  );
}
