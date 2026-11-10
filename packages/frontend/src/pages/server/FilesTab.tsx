import { RotateCcw, Save } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Button, ErrorNotice, LoadingBlock, Notice, Section, cx } from '../../components/ui';
import { useI18n } from '../../i18n';
import { configFilesApi } from '../../lib/endpoints';
import type { RuntimeStatus, ServerView } from '../../lib/types';
import { useQuery } from '../../lib/useQuery';

const isActive = (status: RuntimeStatus): boolean => status.state === 'preparing' || status.state === 'starting' || status.state === 'online' || status.state === 'stopping';

// The settings files of a game as plain text, edited while the server is stopped.
export function FilesTab({ server, status }: { server: ServerView; status: RuntimeStatus }): ReactNode {
  const { t } = useI18n();
  const f = t.zomboidFiles;
  const files = useQuery((signal) => configFilesApi.list(server.id, signal), [server.id]);
  const [key, setKey] = useState<string | null>(null);
  const current = key ?? files.data?.[0]?.key ?? null;
  const content = useQuery((signal) => (current === null ? Promise.resolve(null) : configFilesApi.read(server.id, current, signal)), [server.id, current], current !== null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const locked = isActive(status);
  const original = content.data?.text ?? '';
  const dirty = content.data !== undefined && content.data !== null && text !== original;

  useEffect(() => {
    setText(content.data?.text ?? '');
  }, [content.data]);

  // another file: earlier messages belong to the old one
  useEffect(() => {
    setSaved(false);
    setError(null);
  }, [current]);

  const save = async (): Promise<void> => {
    if (current === null) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      content.setData(await configFilesApi.write(server.id, current, text));
      files.reload();
      setSaved(true);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  if (files.error !== null) return <ErrorNotice error={files.error} action={<Button size="sm" onClick={files.reload}>{t.common.retry}</Button>} />;
  if (files.data === undefined) return <LoadingBlock />;
  const info = files.data.find((file) => file.key === current) ?? null;

  return (
    <div className="space-y-4">
      {locked ? <Notice tone="warn">{f.stopFirst}</Notice> : null}
      <div className="flex flex-wrap gap-2" role="tablist" aria-label={f.pick}>
        {files.data.map((file) => (
          <button
            key={file.key}
            type="button"
            role="tab"
            aria-selected={file.key === current}
            className={cx('btn btn-sm', file.key === current && 'btn-primary')}
            onClick={() => {
              if (dirty && !window.confirm(f.unsaved)) return;
              setKey(file.key);
            }}
          >
            {file.label}
          </button>
        ))}
      </div>
      {info === null ? null : (
        <Section title={info.label} description={info.description}>
          <div className="space-y-3">
            <p className="hint">
              <code className="num">{info.path}</code>
            </p>
            {info.exists ? null : <Notice tone="info">{f.notYet}</Notice>}
            {info.key === 'ini' ? <p className="hint">{f.portsNote}</p> : null}
            {content.error !== null ? <ErrorNotice error={content.error} /> : content.data === undefined ? <LoadingBlock /> : (
              <textarea
                aria-label={f.editorLabel(info.label)}
                className="input num min-h-[28rem] w-full font-mono text-sm leading-relaxed"
                spellCheck={false}
                value={text}
                readOnly={locked}
                onChange={(event) => {
                  setText(event.target.value);
                  setSaved(false);
                }}
              />
            )}
            {error === null ? null : <ErrorNotice error={error} />}
            {saved ? <Notice tone="success">{f.saved}</Notice> : null}
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" icon={Save} loading={busy} disabled={!dirty || locked} onClick={() => void save()}>
                {f.save}
              </Button>
              <Button variant="ghost" icon={RotateCcw} disabled={!dirty} onClick={() => setText(original)}>
                {f.revert}
              </Button>
              {dirty ? <span className="chip chip-warn">{f.unsaved}</span> : null}
            </div>
          </div>
        </Section>
      )}
    </div>
  );
}
