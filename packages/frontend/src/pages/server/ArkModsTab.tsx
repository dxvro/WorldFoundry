import { ArrowDown, ArrowUp, ExternalLink, Plus, Save, Trash2 } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Button, ErrorNotice, Field, LoadingBlock, Notice, Section } from '../../components/ui';
import { useI18n } from '../../i18n';
import { arkModsApi, type WorkshopItem } from '../../lib/endpoints';
import { formatBytes } from '../../lib/format';
import type { RuntimeStatus, ServerView } from '../../lib/types';
import { useQuery } from '../../lib/useQuery';
import { CustomModsSection } from './CustomModsSection';

const isActive = (status: RuntimeStatus): boolean => status.state === 'preparing' || status.state === 'starting' || status.state === 'online' || status.state === 'stopping';
const workshopUrl = (id: string): string => `https://steamcommunity.com/sharedfiles/filedetails/?id=${encodeURIComponent(id)}`;

export function ArkModsTab({ server, status }: { server: ServerView; status: RuntimeStatus }): ReactNode {
  const { t } = useI18n();
  const m = t.ark.mods;
  const w = t.workshop;
  const query = useQuery((signal) => arkModsApi.get(server.id, signal), [server.id]);
  const [mods, setMods] = useState<WorkshopItem[]>([]);
  const [input, setInput] = useState('');
  const [looking, setLooking] = useState(false);
  const [lookupError, setLookupError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const locked = isActive(status);

  useEffect(() => {
    if (query.data !== undefined) setMods(query.data.mods);
  }, [query.data]);
  const dirty = query.data !== undefined && mods.map((mod) => mod.id).join(',') !== query.data.mods.map((mod) => mod.id).join(',');

  const move = (index: number, by: -1 | 1): void => {
    const target = index + by;
    if (target < 0 || target >= mods.length) return;
    const next = [...mods];
    [next[index], next[target]] = [next[target] as WorkshopItem, next[index] as WorkshopItem];
    setMods(next);
  };

  const add = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setLooking(true);
    setLookupError(null);
    try {
      const item = await arkModsApi.lookup(input);
      if (!mods.some((mod) => mod.id === item.id)) setMods([...mods, item]);
      setInput('');
      setSaved(false);
    } catch (caught) {
      setLookupError(caught);
    } finally {
      setLooking(false);
    }
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      query.setData(await arkModsApi.save(server.id, mods.map((mod) => mod.id)));
      setSaved(true);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  if (query.error !== null) return <ErrorNotice error={query.error} action={<Button size="sm" onClick={query.reload}>{t.common.retry}</Button>} />;
  if (query.data === undefined) return <LoadingBlock />;

  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-dim">{m.intro}</p>
      {locked ? <Notice tone="warn">{m.stopFirst}</Notice> : null}
      {query.data.detailsError === null ? null : <Notice tone="warn">{m.detailsFailed}</Notice>}
      <Section title={m.list}>
        <div className="space-y-3">
          <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => void add(event)}>
            <Field label={m.addLabel} hint={m.addHint} className="min-w-0 flex-1">
              {(props) => <input {...props} className="input num" value={input} maxLength={500} disabled={locked} onChange={(event) => setInput(event.target.value)} />}
            </Field>
            <Button type="submit" icon={Plus} loading={looking} disabled={locked || input.trim() === ''}>
              {m.add}
            </Button>
          </form>
          {lookupError === null ? null : <ErrorNotice error={lookupError} />}
          {mods.length === 0 ? (
            <p className="hint">{m.none}</p>
          ) : (
            <ol className="space-y-2" aria-label={m.list}>
              {mods.map((mod, index) => {
                const name = mod.title ?? w.unknown(mod.id);
                return (
                  <li key={mod.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-line p-3">
                    {mod.previewUrl === null ? null : <img src={mod.previewUrl} alt="" className="size-12 shrink-0 rounded-md object-cover" loading="lazy" referrerPolicy="no-referrer" />}
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{name}</p>
                      <p className="num hint">
                        {mod.id}
                        {mod.sizeBytes === null ? '' : ` · ${formatBytes(mod.sizeBytes)}`}
                      </p>
                    </div>
                    <a href={workshopUrl(mod.id)} target="_blank" rel="noopener noreferrer" className="link-btn gap-1 text-sm">
                      <ExternalLink aria-hidden className="size-3.5" />
                      {w.open}
                    </a>
                    <Button size="sm" variant="ghost" iconOnly icon={ArrowUp} aria-label={w.up(name)} disabled={locked || index === 0} onClick={() => move(index, -1)} />
                    <Button size="sm" variant="ghost" iconOnly icon={ArrowDown} aria-label={w.down(name)} disabled={locked || index === mods.length - 1} onClick={() => move(index, 1)} />
                    <Button size="sm" variant="ghost" iconOnly icon={Trash2} aria-label={w.remove(name)} disabled={locked} onClick={() => setMods(mods.filter((entry) => entry.id !== mod.id))} />
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </Section>
      {error === null ? null : <ErrorNotice error={error} />}
      {saved && !dirty ? <Notice tone="success">{m.saved}</Notice> : null}
      <div className="flex items-center gap-2">
        <Button variant="primary" icon={Save} loading={busy} disabled={!dirty || locked} onClick={() => void save()}>
          {m.save}
        </Button>
        {dirty ? <span className="chip chip-warn">{m.unsaved}</span> : null}
      </div>
      <CustomModsSection server={server} status={status} />
    </div>
  );
}
