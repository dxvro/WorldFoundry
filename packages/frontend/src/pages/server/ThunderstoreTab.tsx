import { Download, ExternalLink, Search, Trash2 } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Button, ErrorNotice, LoadingBlock, Notice, Section } from '../../components/ui';
import { useI18n } from '../../i18n';
import { thunderstoreApi, type ThunderstoreOrdering } from '../../lib/endpoints';
import { formatCompact } from '../../lib/format';
import type { RuntimeStatus, ServerView } from '../../lib/types';
import { useQuery } from '../../lib/useQuery';
import { ProjectIcon } from './StoreTab';

const ORDERINGS: readonly ThunderstoreOrdering[] = ['most-downloaded', 'last-updated', 'newest', 'top-rated'];
const isActive = (status: RuntimeStatus): boolean => status.state === 'preparing' || status.state === 'starting' || status.state === 'online' || status.state === 'stopping';
const packageUrl = (fullName: string): string => {
  const [owner, name] = fullName.split('-');
  return `https://thunderstore.io/c/valheim/p/${encodeURIComponent(owner ?? '')}/${encodeURIComponent(name ?? '')}/`;
};

// Thunderstore mods of a Valheim server, with BepInEx
export function ThunderstoreTab({ server, status }: { server: ServerView; status: RuntimeStatus }): ReactNode {
  const { t } = useI18n();
  const ts = t.thunderstore;
  const locked = isActive(status);
  const list = useQuery((signal) => thunderstoreApi.list(server.id, signal), [server.id]);
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [ordering, setOrdering] = useState<ThunderstoreOrdering>('most-downloaded');
  const [offset, setOffset] = useState(0);
  const results = useQuery((signal) => thunderstoreApi.search(server.id, query, ordering, offset, signal), [server.id, query, ordering, offset]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const run = async (key: string, action: () => Promise<string>): Promise<void> => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      setNotice(await action());
      list.reload();
      results.reload();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(null);
    }
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setOffset(0);
    setQuery(input.trim());
  };

  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-dim">{ts.intro}</p>
      {locked ? <Notice tone="warn">{ts.stopFirst}</Notice> : null}
      {error === null ? null : <ErrorNotice error={error} />}
      {notice === null ? null : <Notice tone="success">{notice}</Notice>}

      <Section
        title={ts.installed}
        description={list.data === undefined ? undefined : list.data.bepinex ? ts.bepinexOn : ts.bepinexOff}
        action={list.data?.bepinex === true ? <span className="chip chip-ok">BepInEx</span> : undefined}
      >
        {list.error !== null ? (
          <ErrorNotice error={list.error} />
        ) : list.data === undefined ? (
          <LoadingBlock />
        ) : list.data.mods.length === 0 ? (
          <p className="hint">{ts.noneInstalled}</p>
        ) : (
          <ul className="space-y-2" aria-label={ts.installed}>
            {list.data.mods.map((mod) => (
              <li key={mod.fullName} className="flex flex-wrap items-center gap-3 rounded-lg border border-line p-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{mod.name}</p>
                  <p className="num hint">
                    {mod.fullName} {mod.version}
                    {mod.dependency ? ` · ${ts.dependency}` : ''}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="danger"
                  icon={Trash2}
                  aria-label={ts.remove(mod.name)}
                  loading={busy === mod.fullName}
                  disabled={locked || busy !== null}
                  onClick={() =>
                    void run(mod.fullName, async () => {
                      await thunderstoreApi.remove(server.id, mod.fullName);
                      return ts.removed(mod.name);
                    })
                  }
                >
                  {ts.removeShort}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={ts.search}>
        <div className="space-y-3">
          <form className="flex flex-wrap gap-2" onSubmit={submit} role="search">
            <input className="input min-w-0 flex-[999_1_16rem]" aria-label={ts.searchLabel} value={input} maxLength={100} onChange={(event) => setInput(event.target.value)} />
            <select
              className="input w-auto flex-[1_1_12rem]"
              aria-label={ts.sortLabel}
              value={ordering}
              onChange={(event) => {
                setOffset(0);
                setOrdering(event.target.value as ThunderstoreOrdering);
              }}
            >
              {ORDERINGS.map((entry) => (
                <option key={entry} value={entry}>
                  {ts.orderings[entry]}
                </option>
              ))}
            </select>
            <Button type="submit" icon={Search}>
              {ts.search}
            </Button>
          </form>
          {results.error !== null ? (
            <ErrorNotice error={results.error} action={<Button size="sm" onClick={results.reload}>{t.common.retry}</Button>} />
          ) : results.data === undefined ? (
            <LoadingBlock />
          ) : results.data.hits.length === 0 ? (
            <p className="hint">{ts.noHits}</p>
          ) : (
            <>
              <ul className="space-y-2" aria-label={ts.search}>
                {results.data.hits.map((hit) => (
                  <li key={hit.fullName} className="flex flex-wrap items-center gap-3 rounded-lg border border-line p-3">
                    <ProjectIcon url={hit.icon} title={hit.name} />
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <p className="flex flex-wrap items-baseline gap-x-2">
                        <span className="font-medium">{hit.name}</span>
                        <span className="hint">{ts.by(hit.owner)}</span>
                      </p>
                      <p className="hint line-clamp-2">{hit.summary}</p>
                      <p className="flex flex-wrap items-center gap-1.5">
                        <span className="num hint mr-1">{ts.downloads(formatCompact(hit.downloads))}</span>
                        {hit.serverSide ? <span className="chip chip-accent">{ts.serverSide}</span> : null}
                        {hit.clientSide ? <span className="chip">{ts.clientSide}</span> : null}
                      </p>
                      {hit.clientSide && !hit.serverSide ? <p className="text-sm text-warn">{ts.clientOnly}</p> : null}
                    </div>
                    <a href={packageUrl(hit.fullName)} target="_blank" rel="noopener noreferrer" className="link-btn gap-1 text-sm">
                      <ExternalLink aria-hidden className="size-3.5" />
                      {ts.open}
                    </a>
                    {hit.installed ? (
                      <span className="chip chip-ok">{ts.isInstalled}</span>
                    ) : (
                      <Button
                        size="sm"
                        variant="primary"
                        icon={Download}
                        aria-label={ts.installLabel(hit.name)}
                        loading={busy === hit.fullName}
                        disabled={locked || busy !== null}
                        onClick={() =>
                          void run(hit.fullName, async () => ts.installedNotice((await thunderstoreApi.install(server.id, hit.fullName)).installed.map((mod) => `${mod.name} ${mod.version}`).join(', ')))
                        }
                      >
                        {ts.install}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
              {results.data.offset + results.data.limit < results.data.total ? (
                <Button variant="ghost" onClick={() => setOffset(offset + (results.data?.limit ?? 20))}>
                  {ts.more}
                </Button>
              ) : null}
            </>
          )}
        </div>
      </Section>
    </div>
  );
}
