import { ArrowDown, ArrowUp, ExternalLink, Plus, Save, Trash2 } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Button, ErrorNotice, Field, LoadingBlock, Notice, Section } from '../../components/ui';
import { useI18n } from '../../i18n';
import { workshopApi, type WorkshopItem } from '../../lib/endpoints';
import { formatBytes } from '../../lib/format';
import type { RuntimeStatus, ServerView } from '../../lib/types';
import { useQuery } from '../../lib/useQuery';

const isActive = (status: RuntimeStatus): boolean => status.state === 'preparing' || status.state === 'starting' || status.state === 'online' || status.state === 'stopping';
const move = <T,>(list: T[], index: number, by: -1 | 1): T[] => {
  const next = [...list];
  const target = index + by;
  if (target < 0 || target >= next.length) return list;
  [next[index], next[target]] = [next[target] as T, next[index] as T];
  return next;
};
const workshopUrl = (id: string): string => `https://steamcommunity.com/sharedfiles/filedetails/?id=${encodeURIComponent(id)}`;

function OrderedList({ values, label, onChange, disabled, empty }: { values: string[]; label: string; onChange: (values: string[]) => void; disabled: boolean; empty: string }): ReactNode {
  const { t } = useI18n();
  const w = t.workshop;
  if (values.length === 0) return <p className="hint">{empty}</p>;
  return (
    <ol className="space-y-1" aria-label={label}>
      {values.map((value, index) => (
        <li key={`${value}-${index}`} className="flex items-center gap-2 rounded-md bg-raised px-3 py-1.5">
          <span className="num flex-1 break-all text-sm">{value}</span>
          <Button size="sm" variant="ghost" iconOnly icon={ArrowUp} aria-label={w.up(value)} disabled={disabled || index === 0} onClick={() => onChange(move(values, index, -1))} />
          <Button size="sm" variant="ghost" iconOnly icon={ArrowDown} aria-label={w.down(value)} disabled={disabled || index === values.length - 1} onClick={() => onChange(move(values, index, 1))} />
          <Button size="sm" variant="ghost" iconOnly icon={Trash2} aria-label={w.remove(value)} disabled={disabled} onClick={() => onChange(values.filter((_, at) => at !== index))} />
        </li>
      ))}
    </ol>
  );
}

function AddValue({ label, onAdd, disabled }: { label: string; onAdd: (value: string) => void; disabled: boolean }): ReactNode {
  const [value, setValue] = useState('');
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const clean = value.trim();
    if (clean === '' || clean.includes(';')) return;
    onAdd(clean);
    setValue('');
  };
  return (
    <form className="flex gap-2" onSubmit={submit}>
      <input className="input num" aria-label={label} value={value} maxLength={100} disabled={disabled} onChange={(event) => setValue(event.target.value)} />
      <Button type="submit" size="sm" icon={Plus} disabled={disabled || value.trim() === '' || value.includes(';')}>
        {label}
      </Button>
    </form>
  );
}

// Steam Workshop items of a Project Zomboid server: the three ordered lists of its .ini.
export function WorkshopTab({ server, status }: { server: ServerView; status: RuntimeStatus }): ReactNode {
  const { t } = useI18n();
  const w = t.workshop;
  const query = useQuery((signal) => workshopApi.get(server.id, signal), [server.id]);
  const [items, setItems] = useState<WorkshopItem[]>([]);
  const [mods, setMods] = useState<string[]>([]);
  const [maps, setMaps] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [looking, setLooking] = useState(false);
  const [lookupError, setLookupError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const locked = isActive(status);

  useEffect(() => {
    if (query.data === undefined) return;
    setItems(query.data.items);
    setMods(query.data.mods);
    setMaps(query.data.maps);
  }, [query.data]);

  const dirty =
    query.data !== undefined &&
    (items.map((item) => item.id).join(';') !== query.data.items.map((item) => item.id).join(';') || mods.join(';') !== query.data.mods.join(';') || maps.join(';') !== query.data.maps.join(';'));

  const add = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setLooking(true);
    setLookupError(null);
    try {
      const item = await workshopApi.lookup(input);
      if (!items.some((entry) => entry.id === item.id)) setItems([...items, item]);
      setMods((current) => [...current, ...item.modIds.filter((id) => !current.includes(id))]);
      // a map goes before the base map
      setMaps((current) => {
        const fresh = item.mapFolders.filter((folder) => !current.includes(folder));
        return fresh.length === 0 ? current : [...fresh, ...current];
      });
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
      query.setData(await workshopApi.save(server.id, { items: items.map((item) => item.id), mods, maps }));
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
      <p className="max-w-3xl text-dim">{w.intro}</p>
      {locked ? <Notice tone="warn">{w.stopFirst}</Notice> : null}
      {query.data.detailsError === null ? null : <Notice tone="warn">{w.detailsFailed}</Notice>}

      <Section title={w.items}>
        <div className="space-y-3">
          <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => void add(event)}>
            <Field label={w.addLabel} hint={w.addHint} className="min-w-0 flex-1">
              {(props) => <input {...props} className="input num" value={input} maxLength={500} disabled={locked} onChange={(event) => setInput(event.target.value)} />}
            </Field>
            <Button type="submit" icon={Plus} loading={looking} disabled={locked || input.trim() === ''}>
              {looking ? w.looking : w.add}
            </Button>
          </form>
          {lookupError === null ? null : <ErrorNotice error={lookupError} />}
          {items.length === 0 ? (
            <p className="hint">{w.noItems}</p>
          ) : (
            <ol className="space-y-2" aria-label={w.items}>
              {items.map((item, index) => {
                const name = item.title ?? w.unknown(item.id);
                return (
                  <li key={item.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-line p-3">
                    {item.previewUrl === null ? null : <img src={item.previewUrl} alt="" className="size-12 shrink-0 rounded-md object-cover" loading="lazy" referrerPolicy="no-referrer" />}
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{name}</p>
                      <p className="num hint">
                        {item.id}
                        {item.sizeBytes === null ? '' : ` · ${formatBytes(item.sizeBytes)}`}
                        {item.mapFolders.length === 0 ? '' : ` · ${w.mapFolders(item.mapFolders.join(', '))}`}
                      </p>
                    </div>
                    <a href={workshopUrl(item.id)} target="_blank" rel="noopener noreferrer" className="link-btn gap-1 text-sm">
                      <ExternalLink aria-hidden className="size-3.5" />
                      {w.open}
                    </a>
                    <Button size="sm" variant="ghost" iconOnly icon={ArrowUp} aria-label={w.up(name)} disabled={locked || index === 0} onClick={() => setItems(move(items, index, -1))} />
                    <Button size="sm" variant="ghost" iconOnly icon={ArrowDown} aria-label={w.down(name)} disabled={locked || index === items.length - 1} onClick={() => setItems(move(items, index, 1))} />
                    <Button size="sm" variant="ghost" iconOnly icon={Trash2} aria-label={w.remove(name)} disabled={locked} onClick={() => setItems(items.filter((entry) => entry.id !== item.id))} />
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </Section>

      <Section title={w.mods} description={w.modsHint}>
        <div className="space-y-3">
          <OrderedList values={mods} label={w.mods} onChange={setMods} disabled={locked} empty={w.noMods} />
          <AddValue label={w.addMod} disabled={locked} onAdd={(value) => !mods.includes(value) && setMods([...mods, value])} />
        </div>
      </Section>

      <Section title={w.maps} description={w.mapsHint}>
        <div className="space-y-3">
          <OrderedList values={maps} label={w.maps} onChange={setMaps} disabled={locked} empty="" />
          <AddValue label={w.addMap} disabled={locked} onAdd={(value) => !maps.includes(value) && setMaps([value, ...maps])} />
        </div>
      </Section>

      {error === null ? null : <ErrorNotice error={error} />}
      {saved && !dirty ? <Notice tone="success">{w.saved}</Notice> : null}
      <div className="flex items-center gap-2">
        <Button variant="primary" icon={Save} loading={busy} disabled={!dirty || locked} onClick={() => void save()}>
          {w.save}
        </Button>
        {dirty ? <span className="chip chip-warn">{w.unsaved}</span> : null}
      </div>
    </div>
  );
}
