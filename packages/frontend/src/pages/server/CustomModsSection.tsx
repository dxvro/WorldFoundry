import { Trash2, Upload } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { Button, ErrorNotice, Notice, Section, Spinner } from '../../components/ui';
import { useI18n } from '../../i18n';
import { customModsApi } from '../../lib/endpoints';
import { formatBytes } from '../../lib/format';
import type { RuntimeStatus, ServerView } from '../../lib/types';
import { useQuery } from '../../lib/useQuery';
import { uploadCustomMod } from '../../lib/world';

const runningStates: ReadonlySet<string> = new Set(['preparing', 'starting', 'online', 'stopping']);

// Mods the user uploads as a file, for every game. Minecraft lists them with the other mods (onChanged reloads that list).
export function CustomModsSection({ server, status, onChanged }: { server: ServerView; status: RuntimeStatus; onChanged?: () => void }): ReactNode {
  const { t } = useI18n();
  const c = t.server.world.customMods;
  const minecraft = server.game === 'minecraft';
  const list = useQuery((signal) => customModsApi.list(server.id, signal), [server.id]);
  const input = useRef<HTMLInputElement | null>(null);
  const [percent, setPercent] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [added, setAdded] = useState<string | null>(null);
  const stopped = !runningStates.has(status.state);
  if (list.data !== undefined && !list.data.supported) return null;

  const pick = async (file: File): Promise<void> => {
    setBusy('upload');
    setError(null);
    setAdded(null);
    try {
      const done = await uploadCustomMod(file, server.id, (loaded, total) => setPercent(total > 0 ? Math.floor((loaded / total) * 100) : null));
      setAdded(done.installed.map((mod) => mod.name).join(', '));
      list.reload();
      onChanged?.();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(null);
      setPercent(null);
      if (input.current !== null) input.current.value = '';
    }
  };

  const remove = async (id: string): Promise<void> => {
    setBusy(id);
    setError(null);
    try {
      await customModsApi.remove(server.id, id);
      list.reload();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section
      title={c.title}
      description={c.description}
      action={
        <Button icon={Upload} loading={busy === 'upload'} disabled={!stopped || busy !== null} title={stopped ? undefined : c.locked} onClick={() => input.current?.click()}>
          {c.upload}
        </Button>
      }
    >
      <p className="hint">{c.accepts[server.game]}</p>
      <Notice tone="warn" className="my-3">
        {c.warning}
      </Notice>
      <input
        ref={input}
        type="file"
        className="sr-only"
        aria-label={c.upload}
        accept={list.data?.accept ?? (minecraft ? '.jar' : '.zip,.tar.gz,.tgz')}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file !== undefined) void pick(file);
        }}
      />
      {busy === 'upload' ? (
        <p role="status" className="flex items-center gap-2 text-dim">
          <Spinner />
          {c.uploading(percent ?? 0)}
        </p>
      ) : null}
      {added === null ? null : <Notice tone="success">{c.added(added)}</Notice>}
      {error === null ? null : <ErrorNotice error={error} title={c.failedTitle} />}
      {minecraft || list.data === undefined ? null : list.data.mods.length === 0 ? (
        <p className="text-dim">{c.empty}</p>
      ) : (
        <ul className="divide-y divide-line" aria-label={c.title}>
          {list.data.mods.map((mod) => (
            <li key={mod.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
              <span className="min-w-0">
                <span className="block font-medium text-ink">{mod.name}</span>
                <span className="num block text-xs text-faint">
                  {mod.location} · {formatBytes(mod.sizeBytes)}
                  {mod.active === null ? '' : ` · ${mod.active ? c.active : c.inactive}`}
                </span>
              </span>
              <Button size="sm" variant="danger" icon={Trash2} aria-label={c.remove(mod.name)} loading={busy === mod.id} disabled={!stopped || busy !== null} onClick={() => void remove(mod.id)} />
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
