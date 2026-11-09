import { Download, FileDown, Replace } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Dialog } from '../../components/Dialog';
import { Button, ErrorNotice, Notice, Section, Spinner, Toggle } from '../../components/ui';
import { AnalysisFacts, NoticeList, UploadBox, useImportUpload } from '../../components/WorldImport';
import { renderOptionalRef, useI18n } from '../../i18n';
import { isAbort } from '../../lib/api';
import { formatBytes } from '../../lib/format';
import type { BackupView, RuntimeStatus, ServerView } from '../../lib/types';
import { allAcknowledged, hasBlocker, waitForExport, waitForImport, worldApi, type ExportJobView, type ExportOptions, type ImportJobView, type ImportReview } from '../../lib/world';

const MODS_OPTIONS: ReadonlyArray<ExportOptions['mods']> = ['none', 'manifest', 'jars'];

const runningStates: ReadonlySet<string> = new Set(['preparing', 'starting', 'online', 'stopping']);

export function ExportDialog({ server, backup, open, onClose }: { server: ServerView; backup: BackupView | null; open: boolean; onClose: () => void }): ReactNode {
  const { t } = useI18n();
  const x = t.server.world.export;
  const supportsMods = server.loader !== 'vanilla';
  const [format, setFormat] = useState<ExportOptions['format']>('zip');
  const [mods, setMods] = useState<ExportOptions['mods']>('none');
  const [includeConfig, setIncludeConfig] = useState(false);
  const [job, setJob] = useState<ExportJobView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [starting, setStarting] = useState(false);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) {
      controller.current?.abort();
      setJob(null);
      setError(null);
      setStarting(false);
    }
  }, [open]);
  useEffect(() => () => controller.current?.abort(), []);

  const running = job?.status === 'running';
  const start = async (): Promise<void> => {
    setStarting(true);
    setError(null);
    setJob(null);
    controller.current?.abort();
    const own = new AbortController();
    controller.current = own;
    try {
      const started = backup === null ? await worldApi.startExport(server.id, { format, mods: supportsMods ? mods : 'none', includeConfig }) : await worldApi.startBackupExport(server.id, backup.id, format);
      setJob(started);
      await waitForExport(started.id, setJob, own.signal);
    } catch (cause) {
      if (!isAbort(cause)) setError(cause);
    } finally {
      setStarting(false);
    }
  };

  const title = backup === null ? x.title : x.backupTitle;
  return (
    <Dialog
      open={open}
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{job?.status === 'ready' ? x.close : x.cancel}</Button>
          {job?.status === 'ready' ? (
            <a href={worldApi.exportDownloadUrl(job.id)} download className="btn btn-primary no-underline">
              <Download aria-hidden className="size-4 shrink-0" />
              {x.download}
            </a>
          ) : (
            <Button variant="primary" icon={FileDown} loading={starting || running} onClick={() => void start()}>
              {x.create}
            </Button>
          )}
        </>
      }
    >
      {backup !== null ? (
        <Notice tone="info">{x.backupNotice}</Notice>
      ) : (
        <p className="text-dim">
          {x.description}
          {runningStates.has(server.status.state) ? x.runningNote : ''}
        </p>
      )}
      <fieldset className="space-y-2" disabled={starting || running || job?.status === 'ready'}>
        <legend className="label mb-1.5">{x.format}</legend>
        {(
          [
            ['zip', x.zip, x.zipHint],
            ['tar.gz', x.tarGz, x.tarGzHint],
          ] as const
        ).map(([id, label, hint]) => (
          <label key={id} className="flex cursor-pointer items-start gap-3">
            <input type="radio" name="export-format" checked={format === id} onChange={() => setFormat(id)} className="mt-0.5 size-5 shrink-0 accent-[var(--color-accent)]" />
            <span>
              {label} <span className="hint block">{hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {backup !== null ? null : (
        <>
          {supportsMods ? (
            <fieldset className="space-y-2" disabled={starting || running || job?.status === 'ready'}>
              <legend className="label mb-1.5">{x.modsLegend}</legend>
              {MODS_OPTIONS.map((id) => (
                <label key={id} className="flex cursor-pointer items-start gap-3">
                  <input type="radio" name="export-mods" checked={mods === id} onChange={() => setMods(id)} className="mt-0.5 size-5 shrink-0 accent-[var(--color-accent)]" />
                  <span>
                    {t.server.world.mods[id].label} <span className="hint block">{t.server.world.mods[id].hint}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          ) : null}
          <Toggle checked={includeConfig} onChange={setIncludeConfig} disabled={starting || running || job?.status === 'ready'} label={x.includeConfig} description={x.includeConfigHint} />
        </>
      )}
      {running ? (
        <p role="status" className="flex items-center gap-2 text-dim">
          <Spinner />
          {x.creating}
        </p>
      ) : null}
      {job?.status === 'ready' ? (
        <Notice tone={job.warnings.length > 0 ? 'warn' : 'success'} title={x.readyTitle}>
          <p>{x.readyBody(job.fileName, job.sizeBytes === null ? '' : formatBytes(job.sizeBytes))}</p>
          {job.warnings.map((warning, index) => (
            <p key={`${index}-${warning}`}>{renderOptionalRef(job.warningRefs?.[index], t, warning)}</p>
          ))}
        </Notice>
      ) : null}
      {job?.status === 'failed' ? <Notice tone="error" title={x.failedTitle}>{renderOptionalRef(job.errorRef, t, job.error)}</Notice> : null}
      {error === null ? null : <ErrorNotice error={error} title={x.startFailed} />}
    </Dialog>
  );
}

export function ReplaceDialog({ server, status, open, onClose, onDone }: { server: ServerView; status: RuntimeStatus; open: boolean; onClose: () => void; onDone: () => void }): ReactNode {
  const { t } = useI18n();
  const r = t.server.world.replace;
  const upload = useImportUpload(server.id);
  const stopped = !runningStates.has(status.state);
  const [review, setReview] = useState<ImportReview | null>(null);
  const [reviewError, setReviewError] = useState<unknown>(null);
  const [acknowledged, setAcknowledged] = useState<string[]>([]);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<ImportJobView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const jobId = upload.job?.status === 'staged' ? upload.job.id : null;

  useEffect(() => {
    if (!open) {
      upload.reset();
      setReview(null);
      setReviewError(null);
      setAcknowledged([]);
      setResult(null);
      setError(null);
    }
  }, [open]);

  useEffect(() => {
    if (jobId === null) return;
    const controller = new AbortController();
    setReviewError(null);
    worldApi
      .review(jobId, null, controller.signal)
      .then(setReview)
      .catch((cause: unknown) => {
        if (!isAbort(cause)) setReviewError(cause);
      });
    return () => controller.abort();
  }, [jobId]);

  const analysis = upload.job?.status === 'staged' ? upload.job.analysis : null;
  const notices = [...(analysis?.notices ?? []), ...(review?.notices ?? [])].filter((notice, index, all) => all.findIndex((other) => other.code === notice.code) === index);
  const canApply = jobId !== null && review !== null && stopped && !hasBlocker(notices) && allAcknowledged(notices, acknowledged) && result === null;

  const apply = async (): Promise<void> => {
    if (jobId === null) return;
    setApplying(true);
    setError(null);
    try {
      await worldApi.replaceWorld(server.id, jobId, acknowledged);
      const finished = await waitForImport(jobId, setResult);
      if (finished.status === 'done') onDone();
    } catch (cause) {
      if (!isAbort(cause)) setError(cause);
    } finally {
      setApplying(false);
    }
  };

  const done = result?.status === 'done';
  return (
    <Dialog
      open={open}
      title={r.title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={applying}>
            {done ? r.close : r.cancel}
          </Button>
          {done ? null : (
            <Button variant="danger-solid" icon={Replace} loading={applying} disabled={!canApply} onClick={() => void apply()}>
              {r.title}
            </Button>
          )}
        </>
      }
    >
      {stopped ? null : <Notice tone="error">{r.serverRunning}</Notice>}
      {done ? (
        <Notice tone={result?.result?.warnings.length ? 'warn' : 'success'} title={r.doneTitle}>
          <p>{r.doneBody(result?.result?.folders.join(', ') ?? '')}</p>
          {result?.result?.warnings.map((warning, index) => <p key={`${index}-${warning}`}>{renderOptionalRef(result.result?.warningRefs?.[index], t, warning)}</p>)}
        </Notice>
      ) : (
        <>
          <p className="text-dim">{r.description}</p>
          <UploadBox upload={upload} disabled={!stopped || applying} />
          {analysis === null ? null : (
            <>
              <AnalysisFacts analysis={analysis} />
              {review === null && reviewError === null ? <p role="status" className="flex items-center gap-2 text-dim"><Spinner />{r.reviewing}</p> : null}
              {reviewError === null ? null : <ErrorNotice error={reviewError} />}
              <NoticeList notices={notices} acknowledged={acknowledged} onToggle={(code, checked) => setAcknowledged((current) => (checked ? [...current, code] : current.filter((entry) => entry !== code)))} />
            </>
          )}
          {result?.status === 'failed' ? <Notice tone="error" title={r.failedTitle}>{renderOptionalRef(result.errorRef, t, result.error)}</Notice> : null}
          {error === null ? null : <ErrorNotice error={error} title={r.errorTitle} />}
        </>
      )}
    </Dialog>
  );
}

export function WorldTools({ server, status, exportBackup, onCloseBackupExport }: { server: ServerView; status: RuntimeStatus; exportBackup: BackupView | null; onCloseBackupExport: () => void }): ReactNode {
  const { t } = useI18n();
  const w = t.server.world.tools;
  const [exporting, setExporting] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [replacedAt, setReplacedAt] = useState<number | null>(null);
  const stopped = !runningStates.has(status.state);
  return (
    <Section
      title={w.title}
      description={w.description}
      action={
        <div className="flex flex-wrap gap-2">
          <Button icon={FileDown} onClick={() => setExporting(true)}>
            {w.export}
          </Button>
          <Button icon={Replace} disabled={!stopped} title={stopped ? undefined : w.replaceLocked} onClick={() => setReplacing(true)}>
            {w.replace}
          </Button>
        </div>
      }
    >
      {replacedAt === null ? null : <Notice tone="success">{w.replaced}</Notice>}
      <ExportDialog server={server} backup={null} open={exporting} onClose={() => setExporting(false)} />
      <ExportDialog server={server} backup={exportBackup} open={exportBackup !== null} onClose={onCloseBackupExport} />
      <ReplaceDialog server={server} status={status} open={replacing} onClose={() => setReplacing(false)} onDone={() => setReplacedAt(Date.now())} />
    </Section>
  );
}
