import { ImageUp, Trash2 } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { Button, ErrorNotice, Notice, Section } from '../../components/ui';
import { useI18n } from '../../i18n';
import { serversApi } from '../../lib/endpoints';
import { ICON_ACCEPT, ICON_SIZE, toServerIcon } from '../../lib/icon';
import type { ServerView } from '../../lib/types';

// server-icon.png: the picture in the Minecraft server list
export function ServerIconSection({ server, onSaved }: { server: ServerView; onSaved: (restartRequired: boolean) => void }): ReactNode {
  const { t } = useI18n();
  const c = t.config.icon;
  const input = useRef<HTMLInputElement>(null);
  const [version, setVersion] = useState(() => Date.now());
  const [present, setPresent] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<'saved' | 'removed' | null>(null);

  const upload = async (file: File): Promise<void> => {
    setBusy('upload');
    setError(null);
    setDone(null);
    try {
      let png: Blob;
      try {
        png = await toServerIcon(file);
      } catch {
        throw new Error(c.unreadable);
      }
      const result = await serversApi.setIcon(server.id, png);
      setVersion(Date.now());
      setPresent(true);
      setDone('saved');
      onSaved(result.restartRequired);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(null);
      if (input.current !== null) input.current.value = '';
    }
  };

  const remove = async (): Promise<void> => {
    setBusy('remove');
    setError(null);
    setDone(null);
    try {
      const result = await serversApi.removeIcon(server.id);
      setVersion(Date.now());
      setPresent(false);
      setDone('removed');
      onSaved(result.restartRequired);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section title={c.title} description={c.description(ICON_SIZE)}>
      <div className="flex flex-wrap items-center gap-4">
        <div className="grid size-20 shrink-0 place-items-center overflow-hidden rounded-lg border border-line-strong bg-canvas">
          {present === false ? (
            <span className="hint px-2 text-center text-xs">{c.none}</span>
          ) : (
            <img
              key={version}
              src={serversApi.iconUrl(server.id, version)}
              alt={c.alt(server.name)}
              width={ICON_SIZE}
              height={ICON_SIZE}
              className="size-16 [image-rendering:pixelated]"
              onLoad={() => setPresent(true)}
              onError={() => setPresent(false)}
            />
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            ref={input}
            type="file"
            accept={ICON_ACCEPT}
            className="sr-only"
            aria-label={c.choose}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file !== undefined) void upload(file);
            }}
          />
          <Button icon={ImageUp} loading={busy === 'upload'} disabled={busy !== null} onClick={() => input.current?.click()}>
            {present === true ? c.replace : c.choose}
          </Button>
          {present === true ? (
            <Button variant="ghost" icon={Trash2} loading={busy === 'remove'} disabled={busy !== null} onClick={() => void remove()}>
              {c.remove}
            </Button>
          ) : null}
        </div>
      </div>
      <p className="hint mt-3">{c.hint}</p>
      {error === null ? null : <ErrorNotice error={error} title={c.failed} />}
      {done === null ? null : <Notice tone="success">{done === 'saved' ? c.saved : c.removed}</Notice>}
    </Section>
  );
}
