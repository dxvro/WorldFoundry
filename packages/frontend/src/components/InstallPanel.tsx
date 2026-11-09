import { Download, RotateCw } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { renderOptionalRef, renderRef, useI18n } from '../i18n';
import { hasLogGap, type InstallLogEntry } from '../live/reducer';
import { useLive } from '../live/LiveProvider';
import { serversApi } from '../lib/endpoints';
import type { ServerView } from '../lib/types';
import { Button, ErrorNotice, Notice, ProgressBar, Spinner } from './ui';

function InstallLog({ entries, loading }: { entries: readonly InstallLogEntry[]; loading: boolean }): ReactNode {
  const { t } = useI18n();
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (element !== null) element.scrollTop = element.scrollHeight;
  }, [entries.length]);
  return (
    <pre
      ref={ref}
      tabIndex={0}
      role="log"
      aria-label={t.overview.install.log}
      className="console-body max-h-64 min-h-24 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-canvas p-3 text-dim"
    >
      {entries.length === 0 ? (loading ? t.overview.install.logLoading : t.overview.install.logEmpty) : entries.map((entry) => entry.text).join('\n')}
    </pre>
  );
}

interface InstallPanelProps {
  server: ServerView;
  onDone?: () => void;
}

// Progress, log and retry of an installation. The log comes from install.log when the panel opens (during or
// after an installation) and is continued by the live events; both carry the line number, so nothing doubles up.
export function InstallPanel({ server, onDone }: InstallPanelProps): ReactNode {
  const { t } = useI18n();
  const { state, refresh, loadInstallLog } = useLive();
  const progress = state.installs[server.id];
  const entries = progress?.log ?? [];
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<unknown>(null);
  const [loadingLog, setLoadingLog] = useState(true);
  const [logError, setLogError] = useState<unknown>(null);
  const [truncated, setTruncated] = useState(false);
  const gapReloads = useRef(0);
  const connection = state.connection;
  const serverId = server.id;

  useEffect(() => {
    let cancelled = false;
    setLoadingLog(true);
    loadInstallLog(serverId)
      .then((result) => {
        if (cancelled) return;
        setTruncated(result.truncated);
        setLogError(null);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setLogError(cause);
      })
      .finally(() => {
        if (!cancelled) setLoadingLog(false);
      });
    return () => {
      cancelled = true;
    };
    // again when the connection came back (events may have been missed) and when the run ended
  }, [serverId, server.installState, connection === 'open', loadInstallLog]);

  const gap = hasLogGap(entries);
  useEffect(() => {
    if (!gap || loadingLog || gapReloads.current >= 3) return;
    gapReloads.current += 1;
    void loadInstallLog(serverId).catch(() => undefined);
  }, [gap, loadingLog, serverId, loadInstallLog]);

  const retry = async (): Promise<void> => {
    setRetrying(true);
    setRetryError(null);
    try {
      await serversApi.install(server.id);
      await refresh();
    } catch (cause) {
      setRetryError(cause);
    } finally {
      setRetrying(false);
    }
  };

  const log = (
    <div className="space-y-1">
      <InstallLog entries={entries} loading={loadingLog} />
      {logError === null ? null : <ErrorNotice error={logError} title={t.overview.install.logLoadFailed} />}
      <p className="hint">{t.overview.install.logHint(truncated)}</p>
    </div>
  );

  if (server.installState === 'installed') {
    return (
      <div className="space-y-3">
        <Notice
          tone="success"
          title={t.overview.install.doneTitle}
          {...(onDone === undefined ? {} : { action: <Button size="sm" variant="primary" onClick={onDone}>{t.overview.install.openServer}</Button> })}
        >
          <p>{t.overview.install.doneText}</p>
        </Notice>
        <details className="rounded-lg border border-line p-3">
          <summary className="cursor-pointer text-dim">{t.overview.install.showLog}</summary>
          <div className="mt-2">{log}</div>
        </details>
      </div>
    );
  }

  if (server.installState === 'failed') {
    return (
      <div className="space-y-3">
        <Notice tone="error" title={t.overview.install.failedTitle}>
          <p>{t.overview.install.failedDetail}</p>
        </Notice>
        <pre tabIndex={0} aria-label={t.overview.install.errorLabel} className="console-body max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-bad/40 bg-canvas p-3 text-bad">
          {renderOptionalRef(server.installErrorRef, t, server.installError) ?? t.overview.install.noErrorSaved}
        </pre>
        {log}
        {retryError === null ? null : <ErrorNotice error={retryError} />}
        <Button variant="primary" icon={RotateCw} loading={retrying} onClick={() => void retry()}>
          {t.overview.install.retry}
        </Button>
      </div>
    );
  }

  const pending = server.installState === 'pending';
  const progressText = progress === undefined ? '' : renderRef(progress.messageRef, t, progress.message);
  const phases: Record<string, string | undefined> = t.overview.install.phases;
  const phase = progress === undefined ? (pending ? t.overview.install.waitingForStart : t.overview.install.running) : (phases[progress.phase] ?? progress.phase);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        {pending ? <Download aria-hidden className="size-4 text-accent" /> : <Spinner className="text-accent" />}
        <p className="font-medium" aria-live="polite">
          {phase}
          {progress?.percent == null ? '' : ` (${Math.round(progress.percent)} %)`}
        </p>
      </div>
      <ProgressBar percent={progress?.percent ?? null} label={t.overview.install.progressLabel} />
      {progressText === '' ? null : <p className="hint">{progressText}</p>}
      {log}
      {pending ? (
        <>
          {retryError === null ? null : <ErrorNotice error={retryError} />}
          <Button icon={RotateCw} loading={retrying} onClick={() => void retry()}>
            {t.overview.install.start}
          </Button>
        </>
      ) : null}
    </div>
  );
}
