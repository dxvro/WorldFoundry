import { Eye, EyeOff, Plus, RotateCcw, Save, Trash2, Undo2 } from 'lucide-react';
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { Button, ErrorNotice, Field, LoadingBlock, Notice, Section, Toggle, cx } from '../../components/ui';
import { useI18n } from '../../i18n';
import type { Dictionary } from '../../i18n';
import { ApiError } from '../../lib/api';
import { propertiesApi, serversApi } from '../../lib/endpoints';
import { isKnownPropertyKey } from '../../lib/propertyKeys';
import type { PropertiesEntriesPatch, PropertiesEntriesResult, PropertiesView, PropertyCatalogEntry, PropertyCategory, RuntimeStatus, ServerView } from '../../lib/types';
import { useQuery } from '../../lib/useQuery';
import { useLive } from '../../live/LiveProvider';

type Category = PropertyCategory | 'other';
const CATEGORY_ORDER: readonly Category[] = ['world', 'gameplay', 'players', 'network', 'advanced', 'other'];

// same limits as the backend (properties/catalog.ts)
export const PROPERTY_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
export const MAX_VALUE_LENGTH = 2000;

export interface Row {
  key: string;
  def: PropertyCatalogEntry | undefined;
  inFile: boolean;
  // what the file says now, or the catalog default for a known key that is not in the file
  baseline: string;
  // added in this form, not in the file yet
  isNew: boolean;
}

// older servers wrote game mode and difficulty as numbers; the editor works with the names (the backend maps them back)
const NUMERIC_NAMES: Partial<Record<string, readonly string[]>> = {
  gamemode: ['survival', 'creative', 'adventure', 'spectator'],
  difficulty: ['peaceful', 'easy', 'normal', 'hard'],
};
export function normalizeValue(key: string, value: string): string {
  const names = key === 'gamemode' || key === 'difficulty' ? NUMERIC_NAMES[key] : undefined;
  if (names === undefined || !/^[0-3]$/.test(value)) return value;
  return names[Number(value)] ?? value;
}

// catalog keys in catalog order (with their default when the file has no line for them), then the unknown keys of the file, then the new ones
export function buildRows(entries: PropertiesView['entries'], catalog: readonly PropertyCatalogEntry[], added: readonly string[]): Row[] {
  const fileValues = new Map(entries.map((entry) => [entry.key, entry.value]));
  const known = new Set(catalog.map((def) => def.key));
  const rows: Row[] = catalog.map((def) => ({
    key: def.key,
    def,
    inFile: fileValues.has(def.key),
    baseline: normalizeValue(def.key, fileValues.get(def.key) ?? def.default),
    isNew: false,
  }));
  for (const entry of entries) {
    if (!known.has(entry.key)) rows.push({ key: entry.key, def: undefined, inFile: true, baseline: entry.value, isNew: false });
  }
  for (const key of added) rows.push({ key, def: undefined, inFile: false, baseline: '', isNew: true });
  return rows;
}

const categoryOf = (row: Row): Category => row.def?.category ?? 'other';

// level-name must stay one plain folder name (mirrors isValidLevelName of the backend)
export const isValidLevelName = (raw: string): boolean => {
  const name = raw.trim();
  return !(raw !== name || name === '' || name.length > 100 || name === '.' || name === '..' || /[\\/:*?"<>|\u0000-\u001f]/.test(name) || /[ .]$/.test(name));
};

// the message for a value that the backend would refuse, or undefined
export function valueProblem(row: Row, value: string, t: Dictionary): string | undefined {
  if (value.length > MAX_VALUE_LENGTH) return t.world.field.valueTooLong(MAX_VALUE_LENGTH);
  if (row.key === 'level-name' && !isValidLevelName(value)) return t.world.field.levelNameInvalid;
  if (row.def?.type === 'integer') {
    const number = /^-?\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
    const { min, max } = row.def;
    if (!(number >= (min ?? -2_147_483_647)) || !(number <= (max ?? 2_147_483_647))) return t.world.field.integerInvalid(min, max);
  }
  return undefined;
}

// 400 VALIDATION_ERROR lists the broken values as details [{ path: 'set.<key>', message }]; the message is English
// and not shown, the field is marked with the client-side check of its value or a generic line (see save below)
export function fieldErrorsFrom(error: unknown): { fields: string[]; other: boolean } {
  const fields: string[] = [];
  let other = true;
  if (error instanceof ApiError && error.code === 'VALIDATION_ERROR' && Array.isArray(error.details) && error.details.length > 0) {
    other = false;
    for (const detail of error.details as Array<{ path?: unknown }>) {
      if (typeof detail.path === 'string' && detail.path.startsWith('set.')) fields.push(detail.path.slice(4));
      else other = true;
    }
  }
  return { fields, other };
}

interface Draft {
  edits: Record<string, string>;
  removed: string[];
  added: string[];
}
const EMPTY_DRAFT: Draft = { edits: {}, removed: [], added: [] };

export function draftPatch(rows: readonly Row[], draft: Draft): PropertiesEntriesPatch {
  const set: Record<string, string> = {};
  const remove: string[] = [];
  for (const row of rows) {
    if (draft.removed.includes(row.key)) {
      if (row.inFile) remove.push(row.key);
      continue;
    }
    const edited = draft.edits[row.key];
    if (row.isNew) set[row.key] = edited ?? '';
    else if (edited !== undefined && edited !== row.baseline) set[row.key] = edited;
  }
  return { ...(Object.keys(set).length > 0 ? { set } : {}), ...(remove.length > 0 ? { remove } : {}) };
}

const patchSize = (patch: PropertiesEntriesPatch): number => Object.keys(patch.set ?? {}).length + (patch.remove ?? []).length;

function describe(key: string, t: Dictionary): { label: string; help: string } | undefined {
  return isKnownPropertyKey(key) ? t.world.props[key] : undefined;
}

function enumLabel(value: string, t: Dictionary): string {
  return (t.world.options as Record<string, string | undefined>)[value] ?? value;
}

function Facts({ view, catalog }: { view: PropertiesView; catalog: readonly PropertyCatalogEntry[] }): ReactNode {
  const { t } = useI18n();
  const values = new Map(view.entries.map((entry) => [entry.key, entry.value]));
  const valueOf = (key: string): string => normalizeValue(key, values.get(key) ?? catalog.find((def) => def.key === key)?.default ?? '');
  const yesNo = (value: string): string => (value.toLowerCase() === 'true' ? t.world.facts.yes : t.world.facts.no);
  const seed = valueOf('level-seed');
  const facts: Array<[string, string]> = [
    [t.world.facts.levelName, valueOf('level-name')],
    [t.world.facts.seed, seed === '' ? t.world.facts.seedRandom : seed],
    [t.world.facts.levelType, valueOf('level-type')],
    [t.world.facts.hardcore, yesNo(valueOf('hardcore'))],
    [t.world.facts.gamemode, enumLabel(valueOf('gamemode'), t)],
    [t.world.facts.difficulty, enumLabel(valueOf('difficulty'), t)],
  ];
  return (
    <Section title={t.world.facts.title}>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
        {facts.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="label">{label}</dt>
            <dd className="num font-medium [overflow-wrap:anywhere]">{value}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

interface PropertyRowProps {
  row: Row;
  value: string;
  dirty: boolean;
  removed: boolean;
  error: string | undefined;
  onChange: (value: string) => void;
  onRemove: (() => void) | undefined;
  onUndo: () => void;
}

function PropertyRow({ row, value, dirty, removed, error, onChange, onRemove, onUndo }: PropertyRowProps): ReactNode {
  const { t } = useI18n();
  const [reveal, setReveal] = useState(false);
  const listId = useId();
  const text = describe(row.key, t);
  const label = text?.label ?? row.key;
  const { def } = row;

  if (removed) {
    return (
      <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3" data-testid="property-row" data-key={row.key}>
        <div className="min-w-0 flex-1 basis-56 text-dim [overflow-wrap:anywhere]">
          <p className="num line-through">{row.key}</p>
          <p className="hint">{t.world.field.markedForRemoval}</p>
        </div>
        <Button size="sm" icon={Undo2} aria-label={t.world.field.undoRemoveLabel(row.key)} onClick={onUndo}>
          {t.world.field.undoRemove}
        </Button>
      </li>
    );
  }

  const meta = (
    <>
      {text === undefined ? null : <span className="num">{row.key}</span>}
      {text === undefined ? null : ' · '}
      {def === undefined ? (row.isNew ? t.world.field.newEntry : t.world.field.unknown) : t.world.field.defaultValue(def.type === 'enum' ? enumLabel(def.default, t) : def.default)}
      {def !== undefined && !row.inFile ? ` · ${t.world.field.notInFile}` : ''}
      {dirty ? <span className="chip chip-accent ml-2">{t.world.field.changed}</span> : null}
    </>
  );
  const hint = (
    <>
      {text === undefined ? null : <span className="block text-dim">{text.help}</span>}
      <span className="block">{meta}</span>
      {row.key === 'level-name' && dirty && error === undefined ? <span className="block text-warn">{t.world.levelNameEditedHint}</span> : null}
    </>
  );

  let control: ((props: { id: string; 'aria-describedby': string | undefined; 'aria-invalid': true | undefined }) => ReactNode) | null = null;
  if (def?.type === 'boolean') {
    return (
      <li className={cx('space-y-1 px-4 py-3', dirty && 'bg-accent/5')} data-testid="property-row" data-key={row.key}>
        <Toggle checked={value.toLowerCase() === 'true'} onChange={(checked) => onChange(String(checked))} label={label} description={hint} />
        {error === undefined ? null : (
          <p role="alert" className="text-sm text-bad">
            {error}
          </p>
        )}
      </li>
    );
  }
  if (def?.type === 'enum') {
    const options = def.options ?? [];
    control = (props) => (
      <select {...props} className="input" value={value} onChange={(event) => onChange(event.target.value)}>
        {options.includes(value) ? null : <option value={value}>{value}</option>}
        {options.map((option) => (
          <option key={option} value={option}>
            {enumLabel(option, t)}
          </option>
        ))}
      </select>
    );
  } else if (def?.type === 'integer') {
    control = (props) => (
      <input
        {...props}
        className="input num"
        type="number"
        inputMode="numeric"
        step={1}
        {...(def.min === undefined ? {} : { min: def.min })}
        {...(def.max === undefined ? {} : { max: def.max })}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  } else if (def?.secret === true) {
    control = (props) => (
      <div className="flex gap-2">
        <input {...props} className="input min-w-0 flex-1" type={reveal ? 'text' : 'password'} autoComplete="new-password" spellCheck={false} value={value} onChange={(event) => onChange(event.target.value)} />
        <Button iconOnly icon={reveal ? EyeOff : Eye} onClick={() => setReveal((current) => !current)} aria-pressed={reveal}>
          {t.world.field.secretLabel(label)}
        </Button>
      </div>
    );
  } else {
    const suggestions = def?.suggestions ?? [];
    control = (props) => (
      <div className="flex gap-2">
        <input {...props} className="input min-w-0 flex-1" spellCheck={false} value={value} onChange={(event) => onChange(event.target.value)} {...(suggestions.length > 0 ? { list: listId } : {})} />
        {suggestions.length > 0 ? (
          <datalist id={listId}>
            {suggestions.map((suggestion) => (
              <option key={suggestion} value={suggestion} />
            ))}
          </datalist>
        ) : null}
        {onRemove === undefined ? null : (
          <Button iconOnly icon={Trash2} variant="danger" onClick={onRemove}>
            {t.world.field.removeLabel(row.key)}
          </Button>
        )}
      </div>
    );
  }
  return (
    <li className={cx('px-4 py-3', dirty && 'bg-accent/5')} data-testid="property-row" data-key={row.key}>
      <Field label={label} hint={hint} error={error}>
        {control}
      </Field>
    </li>
  );
}

function AddEntry({ rows, onAdd }: { rows: readonly Row[]; onAdd: (key: string, value: string) => void }): ReactNode {
  const { t } = useI18n();
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  return (
    <Section title={t.world.add.title} description={t.world.add.description}>
      <form
        noValidate
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          const name = key.trim();
          if (name === '') return setError(t.world.add.keyRequired);
          if (!PROPERTY_KEY_PATTERN.test(name)) return setError(t.world.add.keyInvalid);
          if (rows.some((row) => row.key === name)) return setError(t.world.add.keyExists);
          if (value.length > MAX_VALUE_LENGTH) return setError(t.world.field.valueTooLong(MAX_VALUE_LENGTH));
          onAdd(name, value);
          setKey('');
          setValue('');
          setError(undefined);
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t.world.add.keyLabel} error={error}>
            {(props) => (
              <input
                {...props}
                className="input num"
                value={key}
                placeholder={t.world.add.keyPlaceholder}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  setKey(event.target.value);
                  setError(undefined);
                }}
              />
            )}
          </Field>
          <Field label={t.world.add.valueLabel}>
            {(props) => <input {...props} className="input" value={value} autoComplete="off" spellCheck={false} onChange={(event) => setValue(event.target.value)} />}
          </Field>
        </div>
        <p className="hint">{t.world.add.hint}</p>
        <Button type="submit" icon={Plus}>
          {t.world.add.submit}
        </Button>
      </form>
    </Section>
  );
}

interface EditorProps {
  server: ServerView;
  status: RuntimeStatus;
  view: PropertiesView;
  catalog: readonly PropertyCatalogEntry[];
  onSaved: (result: PropertiesEntriesResult) => void;
}

function Editor({ server, status, view, catalog, onSaved }: EditorProps): ReactNode {
  const { t } = useI18n();
  const { refresh, setRestartNeeded } = useLive();
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [search, setSearch] = useState('');
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [invalidNotice, setInvalidNotice] = useState(false);
  const [saved, setSaved] = useState(false);
  const [levelChange, setLevelChange] = useState<{ from: string; to: string } | null>(null);
  // the last save reported that console commands or the next start can overwrite it
  const [savedOverwriteRisk, setSavedOverwriteRisk] = useState(false);
  // while the server runs, console commands (e.g. /whitelist) write their own values back into the file
  const running = status.state === 'online' || status.state === 'starting';

  // a fresh answer from the backend replaces the edits
  useEffect(() => setDraft(EMPTY_DRAFT), [view]);

  const rows = useMemo(() => buildRows(view.entries, catalog, draft.added), [view.entries, catalog, draft.added]);
  const patch = draftPatch(rows, draft);
  const count = patchSize(patch);
  const valueOf = (row: Row): string => draft.edits[row.key] ?? row.baseline;
  const isDirty = (row: Row): boolean => row.isNew || (draft.edits[row.key] !== undefined && draft.edits[row.key] !== row.baseline);
  const isRemoved = (row: Row): boolean => draft.removed.includes(row.key);

  const clientErrors = new Map<string, string>();
  for (const row of rows) {
    if (isRemoved(row) || !isDirty(row)) continue;
    const problem = valueProblem(row, valueOf(row), t);
    if (problem !== undefined) clientErrors.set(row.key, problem);
  }
  const errorOf = (row: Row): string | undefined => clientErrors.get(row.key) ?? serverErrors[row.key];

  const touch = (): void => {
    setSaved(false);
    setInvalidNotice(false);
  };
  const edit = (row: Row, value: string): void => {
    touch();
    setServerErrors(({ [row.key]: _dropped, ...rest }) => rest);
    setDraft((current) => {
      const edits = { ...current.edits };
      // typing the original value back is no change (new entries keep theirs)
      if (!row.isNew && value === row.baseline) delete edits[row.key];
      else edits[row.key] = value;
      return { ...current, edits };
    });
  };
  const remove = (row: Row): void => {
    touch();
    setDraft((current) =>
      row.isNew
        ? { ...current, added: current.added.filter((key) => key !== row.key), edits: Object.fromEntries(Object.entries(current.edits).filter(([key]) => key !== row.key)) }
        : { ...current, removed: [...current.removed, row.key] },
    );
  };
  const undo = (row: Row): void => {
    touch();
    setDraft((current) => ({ ...current, removed: current.removed.filter((key) => key !== row.key) }));
  };
  const add = (key: string, value: string): void => {
    touch();
    setDraft((current) => ({ ...current, added: [...current.added, key], edits: { ...current.edits, [key]: value } }));
  };
  const discard = (): void => {
    touch();
    setDraft(EMPTY_DRAFT);
    setServerErrors({});
    setSaveError(null);
  };

  const save = async (): Promise<void> => {
    if (count === 0 || clientErrors.size > 0) return;
    const levelBefore = rows.find((row) => row.key === 'level-name')?.baseline ?? '';
    setSaving(true);
    setSaveError(null);
    setServerErrors({});
    setInvalidNotice(false);
    try {
      const result = await propertiesApi.setEntries(server.id, patch);
      setSaved(true);
      setSavedOverwriteRisk(result.liveOverwriteRisk === true);
      setLevelChange(result.levelNameChanged ? { from: levelBefore, to: patch.set?.['level-name'] ?? levelBefore } : null);
      if (result.restartRequired) setRestartNeeded(server.id, true);
      onSaved(result);
      void refresh();
    } catch (cause) {
      const { fields, other } = fieldErrorsFrom(cause);
      // the backend's field texts are English: every language shows the client-side check of the value, or a generic line
      setServerErrors(
        Object.fromEntries(
          fields.map((key) => {
            const row = rows.find((candidate) => candidate.key === key);
            return [key, (row === undefined ? undefined : valueProblem(row, valueOf(row), t)) ?? t.world.field.invalidValue];
          }),
        ),
      );
      if (other || fields.length === 0) setSaveError(cause);
      else setInvalidNotice(true);
    } finally {
      setSaving(false);
    }
  };

  const needle = search.trim().toLowerCase();
  const matches = (row: Row): boolean => {
    if (onlyChanged && !(isDirty(row) || isRemoved(row) || row.def === undefined || valueOf(row) !== row.def.default)) return false;
    if (needle === '') return true;
    const text = describe(row.key, t);
    return [row.key, text?.label, text?.help, row.def === undefined ? row.baseline : undefined].some((part) => part?.toLowerCase().includes(needle) === true);
  };
  const shown = rows.filter(matches);

  return (
    <div className="space-y-4">
      {levelChange === null ? null : (
        <Notice tone="warn" title={t.world.levelChangedTitle}>
          {t.world.levelChanged(levelChange.from, levelChange.to)}
        </Notice>
      )}
      {running || savedOverwriteRisk ? (
        <Notice tone="warn" title={t.world.liveRiskTitle}>
          {t.world.liveRisk}
        </Notice>
      ) : null}
      {view.exists ? null : <Notice tone="info">{t.world.noFile}</Notice>}
      <Facts view={view} catalog={catalog} />

      <Section title={t.world.allTitle} description={t.world.intro}>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <Field label={t.world.search.label}>
            {(props) => <input {...props} className="input" type="search" value={search} placeholder={t.world.search.placeholder} autoComplete="off" onChange={(event) => setSearch(event.target.value)} />}
          </Field>
          <label className="flex min-h-11 cursor-pointer items-center gap-3">
            <input type="checkbox" checked={onlyChanged} onChange={(event) => setOnlyChanged(event.target.checked)} className="size-5 shrink-0 accent-[var(--color-accent)]" />
            <span>{t.world.search.onlyChanged}</span>
          </label>
        </div>
      </Section>

      {shown.length === 0 ? <p className="px-1 text-dim">{onlyChanged && needle === '' ? t.world.search.noneChanged : t.world.search.none}</p> : null}
      {CATEGORY_ORDER.map((category) => {
        const inCategory = shown.filter((row) => categoryOf(row) === category);
        if (inCategory.length === 0) return null;
        return (
          <Section key={category} title={t.world.categories[category].title} description={t.world.categories[category].description}>
            <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line">
              {inCategory.map((row) => (
                <PropertyRow
                  key={row.key}
                  row={row}
                  value={valueOf(row)}
                  dirty={isDirty(row)}
                  removed={isRemoved(row)}
                  error={errorOf(row)}
                  onChange={(value) => edit(row, value)}
                  onRemove={row.def === undefined ? () => remove(row) : undefined}
                  onUndo={() => undo(row)}
                />
              ))}
            </ul>
          </Section>
        );
      })}

      <AddEntry rows={rows} onAdd={add} />

      <div className="sticky bottom-2 z-10 space-y-2">
        {saveError === null ? null : <ErrorNotice error={saveError} title={t.world.saveFailed} />}
        {invalidNotice ? (
          <Notice tone="error" title={t.world.saveFailed}>
            {t.world.invalidValues}
          </Notice>
        ) : null}
        {saved && saveError === null && !invalidNotice ? <Notice tone="success">{t.world.saved}</Notice> : null}
        <div className="panel flex flex-wrap items-center justify-between gap-3 p-3 shadow-lg shadow-black/30">
          <div className="min-w-0">
            <p className="num font-medium" aria-live="polite">
              {t.world.bar.changes(count)}
            </p>
            {clientErrors.size > 0 ? <p className="hint text-bad">{t.world.bar.fixErrors}</p> : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button icon={RotateCcw} disabled={count === 0 || saving} onClick={discard}>
              {t.world.bar.discard}
            </Button>
            <Button variant="primary" icon={Save} loading={saving} disabled={count === 0 || clientErrors.size > 0} onClick={() => void save()}>
              {t.world.bar.save}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// the page already shows the "restart needed" notice for a running server; the status here decides the live-overwrite warning
export function WorldTab({ server, status }: { server: ServerView; status: RuntimeStatus }): ReactNode {
  const { t } = useI18n();
  const properties = useQuery((signal) => serversApi.properties(server.id, signal), [server.id]);
  const catalog = useQuery((signal) => propertiesApi.catalog(signal), []);
  const view = properties.data;
  const entries = catalog.data;

  if ((properties.loading || catalog.loading) && (view === undefined || entries === undefined)) return <LoadingBlock label={t.world.loading} />;
  const error = properties.error ?? catalog.error;
  if (error !== null || view === undefined || entries === undefined) {
    return (
      <ErrorNotice
        error={error ?? new Error(t.common.unknownError)}
        title={t.world.loadFailed}
        action={
          <Button
            size="sm"
            onClick={() => {
              properties.reload();
              catalog.reload();
            }}
          >
            {t.common.retry}
          </Button>
        }
      />
    );
  }
  return <Editor server={server} status={status} view={view} catalog={entries} onSaved={(result) => properties.setData(result)} />;
}
