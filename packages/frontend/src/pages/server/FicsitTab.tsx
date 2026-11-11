import { Download, ExternalLink, Search, Trash2 } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Button, ErrorNotice, LoadingBlock, Notice, Section } from '../../components/ui';
import { useI18n } from '../../i18n';
import { ficsitApi } from '../../lib/endpoints';
import { formatCompact } from '../../lib/format';
import type { RuntimeStatus, ServerView } from '../../lib/types';
import { useQuery } from '../../lib/useQuery';
import { CustomModsSection } from './CustomModsSection';

const isActive = (status: RuntimeStatus): boolean => status.state === 'preparing' || status.state === 'starting' || status.state === 'online' || status.state === 'stopping';
const modUrl = (reference: string): string => `https://ficsit.app/mod/${encodeURIComponent(reference)}`;

// ficsit.app mods of a Satisfactory server
export function FicsitTab({ server, status }: { server: ServerView; status: RuntimeStatus }): ReactNode {
  const { t } = useI18n();
  const f = t.ficsit;
  const locked = isActive(status);
  const list = useQuery((signal) => ficsitApi.list(server.id, signal), [server.id]);
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const results = useQuery((signal) => ficsitApi.search(server.id, query, offset, signal), [server.id, query, offset]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const run = async (reference: string, action: () => Promise<string>): Promise<void> => {
    setBusy(reference);
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
      <p className="max-w-3xl text-dim">{f.intro}</p>
      {locked ? <Notice tone="warn">{f.stopFirst}</Notice> : null}
      {error === null ? null : <ErrorNotice error={error} />}
      {notice === null ? null : <Notice tone="success">{notice}</Notice>}

      <Section title={f.installed} description={list.data === undefined ? undefined : list.data.gameBuild === null ? f.gameBuildUnknown : f.gameBuild(list.data.gameBuild)}>
        {list.error !== null ? (
          <ErrorNotice error={list.error} />
        ) : list.data === undefined ? (
          <LoadingBlock />
        ) : list.data.mods.length === 0 ? (
          <p className="hint">{f.noneInstalled}</p>
        ) : (
          <ul className="space-y-2" aria-label={f.installed}>
            {list.data.mods.map((mod) => (
              <li key={mod.reference} className="flex flex-wrap items-center gap-3 rounded-lg border border-line p-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{mod.name}</p>
                  <p className="num hint">
                    {mod.reference} {mod.version}
                    {mod.dependency ? ` · ${f.dependency}` : ''}
                  </p>
                </div>
                <Button size="sm" variant="danger" icon={Trash2} aria-label={f.remove(mod.name)} loading={busy === mod.reference} disabled={locked || busy !== null} onClick={() => void run(mod.reference, async () => {
                  await ficsitApi.remove(server.id, mod.reference);
                  return f.removed(mod.name);
                })}>
                  {f.removeShort}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={f.search}>
        <div className="space-y-3">
          <form className="flex gap-2" onSubmit={submit} role="search">
            <input className="input" aria-label={f.searchLabel} value={input} maxLength={100} onChange={(event) => setInput(event.target.value)} />
            <Button type="submit" icon={Search}>
              {f.search}
            </Button>
          </form>
          {results.error !== null ? (
            <ErrorNotice error={results.error} action={<Button size="sm" onClick={results.reload}>{t.common.retry}</Button>} />
          ) : results.data === undefined ? (
            <LoadingBlock />
          ) : results.data.hits.length === 0 ? (
            <p className="hint">{f.noHits}</p>
          ) : (
            <>
              <ul className="space-y-2" aria-label={f.search}>
                {results.data.hits.map((hit) => (
                  <li key={hit.reference} className="flex flex-wrap items-center gap-3 rounded-lg border border-line p-3">
                    {hit.logo === null ? null : <img src={hit.logo} alt="" className="size-12 shrink-0 rounded-md object-cover" loading="lazy" referrerPolicy="no-referrer" />}
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{hit.name}</p>
                      <p className="hint">{hit.summary}</p>
                      <p className="num hint">{f.downloads(formatCompact(hit.downloads))}</p>
                    </div>
                    <a href={modUrl(hit.reference)} target="_blank" rel="noopener noreferrer" className="link-btn gap-1 text-sm">
                      <ExternalLink aria-hidden className="size-3.5" />
                      {f.open}
                    </a>
                    {hit.installed ? (
                      <span className="chip chip-ok">{f.isInstalled}</span>
                    ) : (
                      <Button
                        size="sm"
                        variant="primary"
                        icon={Download}
                        aria-label={f.installLabel(hit.name)}
                        loading={busy === hit.reference}
                        disabled={locked || busy !== null}
                        onClick={() => void run(hit.reference, async () => f.installedNotice((await ficsitApi.install(server.id, hit.reference)).installed.map((mod) => `${mod.name} ${mod.version}`).join(', ')))}
                      >
                        {f.install}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
              {results.data.offset + results.data.limit < results.data.total ? (
                <Button variant="ghost" onClick={() => setOffset(offset + (results.data?.limit ?? 20))}>
                  {f.more}
                </Button>
              ) : null}
            </>
          )}
        </div>
      </Section>
      <CustomModsSection server={server} status={status} />
    </div>
  );
}
