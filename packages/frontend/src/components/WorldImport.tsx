import { FileArchive, Upload } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { renderRef, useI18n } from '../i18n';
import { getCurrentDictionary } from '../i18n/current';
import { isAbort } from '../lib/api';
import { formatBytes, formatDateTime } from '../lib/format';
import { gameTypeLabel, noticeText, sourceLabel, uploadArchive, waitForImport, worldApi, type ImportJobView, type ImportNoticeView } from '../lib/world';
import type { ImportAnalysisDto } from '@worldfoundry/backend/contract';
import { useQuery } from '../lib/useQuery';
import { ErrorNotice, Notice, ProgressBar, Spinner, cx } from './ui';

export type UploadPhase = 'idle' | 'uploading' | 'analyzing' | 'ready' | 'error';

export interface ImportUpload {
  phase: UploadPhase;
  percent: number | null;
  fileName: string | null;
  job: ImportJobView | null;
  error: unknown;
  pick: (file: File) => void;
  reset: () => void;
}

// Uploads an archive and waits for the analysis; `serverId` makes it an upload for replacing that server's world.
export function useImportUpload(serverId: string | null): ImportUpload {
  const [phase, setPhase] = useState<UploadPhase>('idle');
  const [percent, setPercent] = useState<number | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [job, setJob] = useState<ImportJobView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const controller = useRef<AbortController | null>(null);
  const jobId = useRef<string | null>(null);

  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );

  const reset = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    if (jobId.current !== null) void worldApi.cancelImport(jobId.current).catch(() => undefined);
    jobId.current = null;
    setPhase('idle');
    setPercent(null);
    setFileName(null);
    setJob(null);
    setError(null);
  }, []);

  const pick = useCallback(
    (file: File) => {
      controller.current?.abort();
      const own = new AbortController();
      controller.current = own;
      setFileName(file.name);
      setError(null);
      setJob(null);
      setPercent(0);
      setPhase('uploading');
      void (async () => {
        try {
          const started = await uploadArchive(file, serverId, (loaded, total) => setPercent(total === 0 ? null : Math.round((loaded / total) * 100)), own.signal);
          jobId.current = started.id;
          setPhase('analyzing');
          setPercent(null);
          const result = await waitForImport(started.id, setJob, own.signal);
          if (result.status === 'failed') {
            jobId.current = null;
            setError(new Error(result.error ?? getCurrentDictionary().import.checkFailed));
            setPhase('error');
          } else setPhase('ready');
        } catch (cause) {
          if (isAbort(cause)) return;
          setError(cause);
          setPhase('error');
        }
      })();
    },
    [serverId],
  );

  return { phase, percent, fileName, job, error, pick, reset };
}

export function UploadBox({ upload, disabled = false }: { upload: ImportUpload; disabled?: boolean }): ReactNode {
  const { t } = useI18n();
  const inputId = useId();
  const limits = useQuery((signal) => worldApi.limits(signal), []);
  const [dragging, setDragging] = useState(false);
  const busy = upload.phase === 'uploading' || upload.phase === 'analyzing';
  const maxText = limits.data === undefined ? null : formatBytes(limits.data.maxUploadBytes);

  const onDrop = (event: DragEvent<HTMLLabelElement>): void => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file !== undefined && !busy && !disabled) upload.pick(file);
  };

  return (
    <div className="space-y-3">
      <label
        htmlFor={inputId}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cx(
          'flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed p-6 text-center has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent',
          dragging ? 'border-accent bg-accent/8' : 'border-line-strong bg-canvas hover:border-faint',
          (busy || disabled) && 'pointer-events-none opacity-60',
        )}
      >
        <Upload aria-hidden className="size-7 text-accent" />
        <span className="font-medium">{t.import.dropHere}</span>
        <span className="hint">{t.import.uploadHint(maxText)}</span>
        <input
          id={inputId}
          type="file"
          accept=".zip,.tar.gz,.tgz,application/zip,application/gzip,application/x-gzip"
          className="sr-only"
          disabled={busy || disabled}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file !== undefined) upload.pick(file);
            event.target.value = '';
          }}
        />
      </label>
      {upload.fileName === null ? null : (
        <p className="flex items-center gap-2 text-sm">
          <FileArchive aria-hidden className="size-4 shrink-0 text-dim" />
          <span className="min-w-0 break-all">{upload.fileName}</span>
        </p>
      )}
      {upload.phase === 'uploading' ? <ProgressBar percent={upload.percent} label={t.import.uploading} /> : null}
      {upload.phase === 'analyzing' ? (
        <p role="status" className="flex items-center gap-2 text-dim">
          <Spinner />
          {upload.job === null || upload.job === undefined ? t.import.checkingArchive : renderRef(upload.job.messageRef, t, upload.job.message ?? t.import.checkingArchive)} …
        </p>
      ) : null}
      {upload.phase === 'error' ? <ErrorNotice error={upload.error} title={t.import.notAccepted} /> : null}
    </div>
  );
}

export function AnalysisFacts({ analysis }: { analysis: ImportAnalysisDto }): ReactNode {
  const { t } = useI18n();
  const { world, version, archive } = analysis;
  const gameType = world.gameType === null ? null : (gameTypeLabel(world.gameType) ?? null);
  const facts = t.import.facts;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-1.5" data-testid="analysis-facts">
      <dt className="text-dim">{facts.source}</dt>
      <dd>
        {sourceLabel(analysis.source)}
        <span className="hint">
          {' '}
          · {facts.archiveSizes(formatBytes(archive.sizeBytes), formatBytes(archive.uncompressedBytes))}
        </span>
      </dd>
      <dt className="text-dim">{facts.world}</dt>
      <dd className="break-words">
        {world.levelName ?? world.folderName}
        {gameType === null ? '' : ` · ${gameType}`}
        {world.hardcore === true ? ` · ${facts.hardcore}` : ''}
      </dd>
      <dt className="text-dim">{facts.minecraft}</dt>
      <dd className="num">
        {version.preOneNine ? facts.preOneNine : version.mcVersion === null ? facts.unknown : `${version.mcVersion}${version.approximate ? facts.approximate : ''}`}
      </dd>
      <dt className="text-dim">{facts.dimensions}</dt>
      <dd>
        {facts.overworld}
        {world.hasNether ? facts.nether : ''}
        {world.hasEnd ? facts.end : ''}
        <span className="hint">
          {' '}
          · {world.layout === 'split' ? facts.layoutSplit : world.layout === 'unified' ? facts.layoutUnified : facts.layoutFolder}
        </span>
      </dd>
      {world.lastPlayed === null || world.lastPlayed <= 0 ? null : (
        <>
          <dt className="text-dim">{facts.lastPlayed}</dt>
          <dd className="num">{formatDateTime(world.lastPlayed)}</dd>
        </>
      )}
      {analysis.manifest === null ? null : (
        <>
          <dt className="text-dim">{facts.exported}</dt>
          <dd className="num">
            {formatDateTime(analysis.manifest.createdAt)} <span className="hint">{facts.manifestVersion(analysis.manifest.appVersion)}</span>
          </dd>
        </>
      )}
    </dl>
  );
}

const LEVEL_TONE = { info: 'info', warn: 'warn', error: 'error' } as const;

// Notices of the analysis; those that need an explicit yes come with a checkbox
export function NoticeList({ notices, acknowledged, onToggle }: { notices: readonly ImportNoticeView[]; acknowledged: readonly string[]; onToggle: (code: string, checked: boolean) => void }): ReactNode {
  const { t } = useI18n();
  if (notices.length === 0) return null;
  return (
    <ul className="space-y-2" aria-label={t.import.noticeListLabel}>
      {notices.map((notice) => (
        <li key={notice.code}>
          <Notice tone={LEVEL_TONE[notice.level]}>
            <p>{noticeText(notice, t)}</p>
            {notice.needsConfirm ? (
              <label className="mt-2 flex cursor-pointer items-start gap-3 text-ink">
                <input
                  type="checkbox"
                  checked={acknowledged.includes(notice.code)}
                  onChange={(event) => onToggle(notice.code, event.target.checked)}
                  className="mt-0.5 size-5 shrink-0 accent-[var(--color-accent)]"
                />
                <span>{t.import.acknowledge}</span>
              </label>
            ) : null}
          </Notice>
        </li>
      ))}
    </ul>
  );
}
