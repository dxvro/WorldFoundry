import { Search } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '../i18n';
import { modpacksApi } from '../lib/endpoints';
import { formatCompact } from '../lib/format';
import type { ModpackVersionDto } from '../lib/types';
import { useQuery } from '../lib/useQuery';
import type { SelectedPack, SelectedPackVersion } from '../lib/wizard';
import { ProjectIcon, useDebounced } from '../pages/server/StoreTab';
import { ErrorNotice, Field, LoadingBlock, cx } from './ui';

const LOADER_NAMES: Record<string, string> = { fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge', quilt: 'Quilt' };
const loaderNames = (loaders: readonly string[]): string => loaders.map((loader) => LOADER_NAMES[loader] ?? loader).join(', ');

const toSelected = (version: ModpackVersionDto): SelectedPackVersion => ({
  id: version.id,
  versionNumber: version.versionNumber,
  loaders: version.loaders,
  gameVersions: version.gameVersions,
});

// Search Modrinth for a modpack and choose one of its versions (the "Modpack" step of the new-server assistant)
export function ModpackPicker({
  pack,
  version,
  onPack,
  onVersion,
  errors,
}: {
  pack: SelectedPack | null;
  version: SelectedPackVersion | null;
  onPack: (pack: SelectedPack) => void;
  onVersion: (version: SelectedPackVersion | null) => void;
  errors: { pack?: string | undefined; packVersion?: string | undefined };
}): ReactNode {
  const { t } = useI18n();
  const m = t.wizard.modpack;
  const [text, setText] = useState('');
  const query = useDebounced(text.trim(), 350);
  const results = useQuery((signal) => modpacksApi.search(query, 0, signal), [query]);
  const versions = useQuery((signal) => modpacksApi.versions(pack?.projectId ?? '', signal), [pack?.projectId], pack !== null);

  // a newly chosen pack starts on its newest supported release
  useEffect(() => {
    const list = versions.data;
    if (list === undefined) return;
    if (version !== null && list.some((entry) => entry.id === version.id && entry.supported)) return;
    const supported = list.filter((entry) => entry.supported);
    const pick = supported.find((entry) => entry.versionType === 'release') ?? supported[0];
    onVersion(pick === undefined ? null : toSelected(pick));
    // onVersion changes on every render of the parent; the list is what matters
  }, [versions.data]);

  const hits = results.data?.hits ?? [];
  return (
    <div className="space-y-4">
      <Field label={m.searchLabel} error={errors.pack}>
        {(props) => (
          <div className="relative">
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
            <input {...props} type="search" className="input pl-9" value={text} placeholder={m.searchPlaceholder} autoComplete="off" onChange={(event) => setText(event.target.value)} />
          </div>
        )}
      </Field>

      {results.error !== null ? (
        <ErrorNotice error={results.error} title={m.searchFailed} />
      ) : results.loading && results.data === undefined ? (
        <LoadingBlock />
      ) : (
        <fieldset className="space-y-2">
          <legend className="hint mb-1">{query === '' ? m.popular : m.results(results.data?.totalHits ?? 0)}</legend>
          {hits.length === 0 ? <p className="hint">{m.noResults}</p> : null}
          <div className="max-h-[26rem] space-y-2 overflow-y-auto pr-1">
            {hits.map((hit) => {
              const selected = pack?.projectId === hit.projectId;
              return (
                <label
                  key={hit.projectId}
                  className={cx(
                    'flex cursor-pointer gap-3 rounded-lg border p-3 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent',
                    selected ? 'border-accent bg-accent/8' : 'border-line-strong bg-canvas hover:border-faint',
                  )}
                >
                  <input
                    type="radio"
                    name="modpack"
                    value={hit.projectId}
                    checked={selected}
                    className="sr-only"
                    onChange={() => {
                      if (selected) return;
                      onVersion(null);
                      onPack({ projectId: hit.projectId, title: hit.title, iconUrl: hit.iconUrl });
                    }}
                  />
                  <ProjectIcon url={hit.iconUrl} title={hit.title} />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-baseline gap-x-2">
                      <span className="font-medium">{hit.title}</span>
                      <span className="hint">{m.by(hit.author)}</span>
                      {selected ? <span className="chip chip-ok">{m.selected}</span> : null}
                    </span>
                    <span className="hint line-clamp-2 block">{hit.description}</span>
                    <span className="hint num block">{m.downloads(formatCompact(hit.downloads))}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
      )}

      {pack === null ? null : versions.loading ? (
        <LoadingBlock label={m.versionsLoading} />
      ) : versions.error !== null ? (
        <ErrorNotice error={versions.error} title={m.versionsFailed} />
      ) : (versions.data ?? []).length === 0 ? (
        <p className="hint">{m.noVersions}</p>
      ) : (
        <Field label={m.versionLabel} error={errors.packVersion} hint={version === null ? undefined : m.versionDetail(loaderNames(version.loaders), version.gameVersions.join(', '))}>
          {(props) => (
            <select
              {...props}
              className="input"
              value={version?.id ?? ''}
              onChange={(event) => {
                const next = (versions.data ?? []).find((entry) => entry.id === event.target.value);
                onVersion(next === undefined ? null : toSelected(next));
              }}
            >
              <option value="">{t.wizard.choose}</option>
              {(versions.data ?? []).map((entry) => (
                <option key={entry.id} value={entry.id} disabled={!entry.supported}>
                  {entry.versionNumber} · {loaderNames(entry.loaders)} · {entry.gameVersions.join(', ')}
                  {entry.versionType === 'release' ? '' : m.prerelease(entry.versionType)}
                  {entry.supported ? '' : m.unsupported}
                </option>
              ))}
            </select>
          )}
        </Field>
      )}
      <p className="hint">{m.hint}</p>
    </div>
  );
}
