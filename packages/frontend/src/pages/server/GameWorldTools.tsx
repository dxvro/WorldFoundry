import { FileDown, Upload } from 'lucide-react';
import { useId, useRef, useState, type ReactNode } from 'react';
import { Dialog } from '../../components/Dialog';
import { Button, ErrorNotice, Notice, Section, Spinner } from '../../components/ui';
import { renderOptionalRef, useI18n } from '../../i18n';
import { isAbort } from '../../lib/api';
import type { BackupView, RuntimeStatus, ServerView } from '../../lib/types';
import { uploadGameWorld, type GameImportView } from '../../lib/world';
import { ExportDialog } from './WorldTools';

const runningStates: ReadonlySet<string> = new Set(['preparing', 'starting', 'online', 'stopping']);
const ACCEPT: Record<string, string> = { satisfactory: '.sav,.zip,.tar.gz,.tgz' };

// Export and import of the world for Project Zomboid, Satisfactory and ARK. The import becomes a backup of the server
// and is restored like one, so the world before it is kept as a safety backup.
export function GameWorldTools({ server, status, exportBackup, onCloseBackupExport, onImported }: { server: ServerView; status: RuntimeStatus; exportBackup: BackupView | null; onCloseBackupExport: () => void; onImported: () => void }): ReactNode {
  const { t } = useI18n();
  const g = t.server.world.game;
  const inputId = useId();
  const input = useRef<HTMLInputElement | null>(null);
  const [exporting, setExporting] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [percent, setPercent] = useState<number | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<GameImportView | null>(null);
  const controller = useRef<AbortController | null>(null);
  const stopped = !runningStates.has(status.state);

  const close = (): void => {
    if (working) controller.current?.abort();
    setFile(null);
    setPercent(null);
    setError(null);
    if (input.current !== null) input.current.value = '';
  };

  const run = async (): Promise<void> => {
    if (file === null) return;
    setWorking(true);
    setError(null);
    setResult(null);
    const own = new AbortController();
    controller.current = own;
    try {
      const done = await uploadGameWorld(file, server.id, (loaded, total) => setPercent(total > 0 ? Math.floor((loaded / total) * 100) : null), own.signal);
      setResult(done);
      setFile(null);
      if (input.current !== null) input.current.value = '';
      onImported();
    } catch (cause) {
      if (!isAbort(cause)) setError(cause);
    } finally {
      setWorking(false);
      setPercent(null);
    }
  };

  return (
    <Section
      title={g.title}
      description={g.description}
      action={
        <div className="flex flex-wrap gap-2">
          <Button icon={FileDown} disabled={!stopped} title={stopped ? undefined : g.locked} onClick={() => setExporting(true)}>
            {g.export}
          </Button>
          <Button icon={Upload} disabled={!stopped} title={stopped ? undefined : g.locked} onClick={() => input.current?.click()}>
            {g.import}
          </Button>
        </div>
      }
    >
      <p className="hint">{g.accepts[server.game]}</p>
      <input
        id={inputId}
        ref={input}
        type="file"
        className="sr-only"
        aria-label={g.import}
        accept={ACCEPT[server.game] ?? '.zip,.tar.gz,.tgz'}
        onChange={(event) => {
          const picked = event.target.files?.[0] ?? null;
          setResult(null);
          setError(null);
          setFile(picked);
        }}
      />
      {result === null ? null : (
        <Notice tone={result.warnings.length > 0 ? 'warn' : 'success'} title={g.doneTitle}>
          <p>{g.doneBody(result.safety !== null)}</p>
          {result.warnings.map((warning, index) => (
            <p key={`${index}-${warning}`}>{renderOptionalRef(result.warningRefs[index], t, warning)}</p>
          ))}
        </Notice>
      )}
      <ExportDialog server={server} backup={null} open={exporting} onClose={() => setExporting(false)} />
      <ExportDialog server={server} backup={exportBackup} open={exportBackup !== null} onClose={onCloseBackupExport} />
      <Dialog
        open={file !== null}
        title={g.dialogTitle}
        onClose={close}
        footer={
          <>
            <Button onClick={close}>{t.common.cancel}</Button>
            <Button variant="danger-solid" icon={Upload} loading={working} disabled={!stopped} onClick={() => void run()}>
              {g.confirm}
            </Button>
          </>
        }
      >
        <Notice tone="warn" title={g.warningTitle}>
          {g.warning(file?.name ?? '')}
        </Notice>
        {working ? (
          <p role="status" className="flex items-center gap-2 text-dim">
            <Spinner />
            {percent !== null && percent < 100 ? g.uploading(percent) : g.working}
          </p>
        ) : null}
        {error === null ? null : <ErrorNotice error={error} title={g.failedTitle} />}
      </Dialog>
    </Section>
  );
}
