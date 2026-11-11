import { Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Dialog } from '../../components/Dialog';
import { Button, ErrorNotice, Field, Notice, Section } from '../../components/ui';
import { useI18n } from '../../i18n';
import { backupsApi, serversApi } from '../../lib/endpoints';
import { formatBytes } from '../../lib/format';
import { useRouter } from '../../lib/router';
import type { RuntimeStatus, ServerView } from '../../lib/types';
import { useLive } from '../../live/LiveProvider';

// Deleting a server removes its whole folder on the machine (world or save games, settings, mods, the installed server
// files). Because nothing can be restored afterwards, the dialog says so plainly and asks for two confirmations: a
// checkbox that the data is lost, and the server name typed by hand. Shared by every game.
export function DeleteServerSection({ server, status }: { server: ServerView; status: RuntimeStatus }): ReactNode {
  const { t } = useI18n();
  const d = t.config.danger;
  const { navigate } = useRouter();
  const { refresh } = useLive();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [understood, setUnderstood] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const running = status.state === 'preparing' || status.state === 'starting' || status.state === 'online' || status.state === 'stopping';
  const [archives, setArchives] = useState<{ count: number; sizeBytes: number } | null>(null);
  const [choice, setChoice] = useState<'delete' | 'keep' | null>(null);
  const installing = server.installState === 'installing';

  const close = (): void => {
    setOpen(false);
    setTyped('');
    setUnderstood(false);
    setError(null);
    setChoice(null);
  };

  const openDialog = (): void => {
    setOpen(true);
    setArchives(null);
    setChoice(null);
    setUnderstood(false);
    backupsApi
      .list(server.id)
      .then((list) => setArchives({ count: list.backups.length, sizeBytes: list.totalBytes }))
      .catch(() => setArchives({ count: 0, sizeBytes: 0 }));
  };

  const remove = async (): Promise<void> => {
    setDeleting(true);
    setError(null);
    try {
      await serversApi.remove(server.id, choice ?? undefined);
      await refresh();
      navigate('/', { replace: true });
    } catch (cause) {
      setError(cause);
      setDeleting(false);
    }
  };

  const ready = understood && typed === server.name && archives !== null && (archives.count === 0 || choice !== null);

  return (
    <Section title={d.title} description={d.description}>
      {running ? <Notice tone="warn" className="mb-3">{d.running}</Notice> : null}
      {installing ? <Notice tone="warn" className="mb-3">{d.installing}</Notice> : null}
      <Button variant="danger" icon={Trash2} disabled={running || installing} onClick={openDialog}>
        {d.open}
      </Button>
      <Dialog
        open={open}
        title={d.dialogTitle}
        onClose={close}
        footer={
          <>
            <Button onClick={close}>{t.common.cancel}</Button>
            <Button variant="danger-solid" icon={Trash2} loading={deleting} disabled={!ready} onClick={() => void remove()}>
              {d.confirm}
            </Button>
          </>
        }
      >
        <Notice tone="error" title={d.noticeTitle}>
          <p>{d.notice(server.name)}</p>
          <p className="mt-2">{d.backupFirst}</p>
        </Notice>
        {archives === null || archives.count === 0 ? null : (
          <fieldset className="space-y-2 rounded-lg border border-line-strong bg-canvas p-3">
            <legend className="px-1 font-medium">{d.backupsQuestion(archives.count, formatBytes(archives.sizeBytes))}</legend>
            <label className="flex cursor-pointer items-start gap-3">
              <input type="radio" name="backups" checked={choice === 'delete'} onChange={() => setChoice('delete')} className="mt-1 size-5 shrink-0 accent-[var(--color-accent)]" />
              <span>{d.deleteWithServer}</span>
            </label>
            <label className="flex cursor-pointer items-start gap-3">
              <input type="radio" name="backups" checked={choice === 'keep'} onChange={() => setChoice('keep')} className="mt-1 size-5 shrink-0 accent-[var(--color-accent)]" />
              <span>
                {d.keep}
                <span className="hint block">{d.keepHint(server.id)}</span>
              </span>
            </label>
          </fieldset>
        )}
        <label className="flex cursor-pointer items-start gap-3 font-medium">
          <input type="checkbox" checked={understood} onChange={(event) => setUnderstood(event.target.checked)} className="mt-1 size-5 shrink-0 accent-[var(--color-bad)]" />
          <span>{d.understood}</span>
        </label>
        <Field label={d.typeName(server.name)}>
          {(props) => <input {...props} className="input" value={typed} autoComplete="off" spellCheck={false} onChange={(event) => setTyped(event.target.value)} />}
        </Field>
        {error === null ? null : <ErrorNotice error={error} />}
      </Dialog>
    </Section>
  );
}
