import { ExternalLink, RefreshCw, Save } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, ErrorNotice, Field, LoadingBlock, Notice, Range, Section, Toggle } from '../../components/ui';
import { EULA_URL } from '../../lib/constants';
import { systemApi, serversApi } from '../../lib/endpoints';
import { useI18n } from '../../i18n';
import { getCurrentDictionary } from '../../i18n/current';
import { formatMb } from '../../lib/format';
import { javaFit } from '../../lib/java';
import { ramBounds, validateRam, withMax, withMin } from '../../lib/ram';
import { Link, serverPath } from '../../lib/router';
import type { PropertiesPatch, PropertiesView, RuntimeStatus, ServerView, SystemInfo, TypedProperties, UpdateServerInput } from '../../lib/types';
import { useQuery } from '../../lib/useQuery';
import { useLive } from '../../live/LiveProvider';
import { DeleteServerSection } from './DeleteServerSection';
import { JavaRuntimes } from './JavaRuntimes';

type Gamemode = TypedProperties['gamemode'];
type Difficulty = TypedProperties['difficulty'];

// Record types make the compiler flag a new option the backend adds (the labels live in the dictionary, config.gamemode / config.difficulty)
const GAMEMODES: Record<Gamemode, true> = { survival: true, creative: true, adventure: true, spectator: true };
const DIFFICULTIES: Record<Difficulty, true> = { peaceful: true, easy: true, normal: true, hard: true };

interface PropertiesForm {
  port: string;
  gamemode: Gamemode;
  difficulty: Difficulty;
  whitelist: boolean;
  maxPlayers: string;
  viewDistance: string;
  onlineMode: boolean;
  motd: string;
}

const toForm = (properties: TypedProperties): PropertiesForm => ({
  port: String(properties['server-port']),
  gamemode: properties.gamemode,
  difficulty: properties.difficulty,
  whitelist: properties['white-list'],
  maxPlayers: String(properties['max-players']),
  viewDistance: String(properties['view-distance']),
  onlineMode: properties['online-mode'],
  motd: properties.motd,
});

const integerIn = (text: string, min: number, max: number): number | null => {
  if (!/^\d{1,6}$/.test(text.trim())) return null;
  const value = Number(text.trim());
  return value >= min && value <= max ? value : null;
};

type PropertyErrors = Partial<Record<keyof PropertiesForm, string>>;

export function validateProperties(form: PropertiesForm): PropertyErrors {
  const errors: PropertyErrors = {};
  const text = getCurrentDictionary().config.validation;
  if (integerIn(form.port, 1, 65535) === null) errors.port = text.port;
  if (integerIn(form.maxPlayers, 1, 10_000) === null) errors.maxPlayers = text.maxPlayers;
  if (integerIn(form.viewDistance, 2, 32) === null) errors.viewDistance = text.viewDistance;
  if (form.motd.length > 500) errors.motd = text.motd;
  return errors;
}

export function propertiesPatch(current: TypedProperties, form: PropertiesForm): PropertiesPatch {
  const patch: PropertiesPatch = {};
  const port = integerIn(form.port, 1, 65535);
  const maxPlayers = integerIn(form.maxPlayers, 1, 10_000);
  const viewDistance = integerIn(form.viewDistance, 2, 32);
  if (port !== null && port !== current['server-port']) patch['server-port'] = port;
  if (form.gamemode !== current.gamemode) patch.gamemode = form.gamemode;
  if (form.difficulty !== current.difficulty) patch.difficulty = form.difficulty;
  if (form.whitelist !== current['white-list']) patch['white-list'] = form.whitelist;
  if (maxPlayers !== null && maxPlayers !== current['max-players']) patch['max-players'] = maxPlayers;
  if (viewDistance !== null && viewDistance !== current['view-distance']) patch['view-distance'] = viewDistance;
  if (form.onlineMode !== current['online-mode']) patch['online-mode'] = form.onlineMode;
  if (form.motd !== current.motd) patch.motd = form.motd;
  return patch;
}

function PropertiesSection({ server, view, onSaved }: { server: ServerView; view: PropertiesView; onSaved: (view: PropertiesView, restartRequired: boolean) => void }): ReactNode {
  const { t } = useI18n();
  const p = t.config.properties;
  const [form, setForm] = useState<PropertiesForm>(() => toForm(view.properties));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const [showErrors, setShowErrors] = useState(false);

  useEffect(() => setForm(toForm(view.properties)), [view]);

  const errors = validateProperties(form);
  const patch = propertiesPatch(view.properties, form);
  const dirty = Object.keys(patch).length > 0;
  const shown = showErrors ? errors : {};
  const set = <K extends keyof PropertiesForm>(key: K, value: PropertiesForm[K]): void => {
    setForm((current) => ({ ...current, [key]: value }));
    setSaved(false);
  };

  const save = async (): Promise<void> => {
    if (Object.keys(errors).length > 0) {
      setShowErrors(true);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await serversApi.patchProperties(server.id, patch);
      setSaved(true);
      setShowErrors(false);
      onSaved(result, result.restartRequired);
    } catch (cause) {
      setError(cause);
    } finally {
      setSaving(false);
    }
  };

  const extra = Object.entries(view.extra);
  return (
    <Section
      title={p.title}
      description={view.exists ? p.descriptionExists : p.descriptionNew}
    >
      <form
        noValidate
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={p.port} error={shown.port}>
            {(props) => <input {...props} className="input num" inputMode="numeric" value={form.port} onChange={(event) => set('port', event.target.value)} />}
          </Field>
          <Field label={p.maxPlayers} error={shown.maxPlayers}>
            {(props) => <input {...props} className="input num" inputMode="numeric" value={form.maxPlayers} onChange={(event) => set('maxPlayers', event.target.value)} />}
          </Field>
          <Field label={p.gamemode}>
            {(props) => (
              <select {...props} className="input" value={form.gamemode} onChange={(event) => set('gamemode', event.target.value as Gamemode)}>
                {(Object.keys(GAMEMODES) as Gamemode[]).map((key) => (
                  <option key={key} value={key}>
                    {t.config.gamemode[key]}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label={p.difficulty}>
            {(props) => (
              <select {...props} className="input" value={form.difficulty} onChange={(event) => set('difficulty', event.target.value as Difficulty)}>
                {(Object.keys(DIFFICULTIES) as Difficulty[]).map((key) => (
                  <option key={key} value={key}>
                    {t.config.difficulty[key]}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label={p.viewDistance} error={shown.viewDistance}>
            {(props) => <input {...props} className="input num" inputMode="numeric" value={form.viewDistance} onChange={(event) => set('viewDistance', event.target.value)} />}
          </Field>
        </div>
        <Field label={p.motd} error={shown.motd}>
          {(props) => <input {...props} className="input" value={form.motd} onChange={(event) => set('motd', event.target.value)} />}
        </Field>
        <Toggle checked={form.whitelist} onChange={(value) => set('whitelist', value)} label={p.whitelist} description={p.whitelistHint} />
        <Toggle
          checked={form.onlineMode}
          onChange={(value) => set('onlineMode', value)}
          label={p.onlineMode}
          description={p.onlineModeHint}
        />
        {extra.length === 0 ? null : (
          <p className="hint">
            {p.moreEntries(extra.length)}{' '}
            <Link to={serverPath(server.id, 'world')}>{p.openWorld}</Link>
          </p>
        )}
        {error === null ? null : <ErrorNotice error={error} title={p.saveFailed} />}
        {saved ? <Notice tone="success">{t.config.saved}</Notice> : null}
        <Button type="submit" variant="primary" icon={Save} loading={saving} disabled={!dirty}>
          {p.save}
        </Button>
      </form>
    </Section>
  );
}

function JvmSection({ server, system, onRescan, rescanning, onSaved }: { server: ServerView; system: SystemInfo | undefined; onRescan: () => void; rescanning: boolean; onSaved: (restartRequired: boolean) => void }): ReactNode {
  const { t } = useI18n();
  const j = t.config.jvm;
  const total = system?.totalMemoryMb ?? server.maxRamMb;
  const bounds = ramBounds(Math.max(total, server.maxRamMb));
  const [ram, setRam] = useState({ minRamMb: server.minRamMb, maxRamMb: server.maxRamMb });
  const [aikar, setAikar] = useState(server.useAikarFlags);
  const [javaPath, setJavaPath] = useState(server.javaPath ?? '');
  const [args, setArgs] = useState(server.extraJvmArgs);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setRam({ minRamMb: server.minRamMb, maxRamMb: server.maxRamMb });
    setAikar(server.useAikarFlags);
    setJavaPath(server.javaPath ?? '');
    setArgs(server.extraJvmArgs);
  }, [server.minRamMb, server.maxRamMb, server.useAikarFlags, server.javaPath, server.extraJvmArgs]);

  const runtimes = system?.javaRuntimes ?? [];
  const requirement = { requiredJavaMajor: server.requiredJavaMajor, loader: server.loader, mcVersion: server.mcVersion };
  const known = runtimes.some((runtime) => runtime.path === javaPath);
  const ramErrors = system === undefined ? {} : validateRam(ram, total);
  const automatic = runtimes.filter((runtime) => javaFit(runtime, requirement).fits).sort((a, b) => a.major - b.major)[0];

  const patch: UpdateServerInput = {};
  if (ram.minRamMb !== server.minRamMb) patch.minRamMb = ram.minRamMb;
  if (ram.maxRamMb !== server.maxRamMb) patch.maxRamMb = ram.maxRamMb;
  if (aikar !== server.useAikarFlags) patch.useAikarFlags = aikar;
  if (javaPath !== (server.javaPath ?? '')) patch.javaPath = javaPath === '' ? null : javaPath;
  if (args !== server.extraJvmArgs) patch.extraJvmArgs = args;
  const dirty = Object.keys(patch).length > 0;
  const touch = (): void => setSaved(false);

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const result = await serversApi.update(server.id, patch);
      setSaved(true);
      onSaved(result.restartRequired);
    } catch (cause) {
      setError(cause);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section title={j.title} description={j.description}>
      <form
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Range
            label={j.minRam}
            value={ram.minRamMb}
            min={bounds.min}
            max={bounds.max}
            step={bounds.step}
            format={formatMb}
            error={ramErrors.minRamMb}
            onChange={(value) => {
              touch();
              setRam((current) => withMin(current, value, bounds));
            }}
          />
          <Range
            label={j.maxRam}
            value={ram.maxRamMb}
            min={bounds.min}
            max={bounds.max}
            step={bounds.step}
            format={formatMb}
            error={ramErrors.maxRamMb}
            onChange={(value) => {
              touch();
              setRam((current) => withMax(current, value, bounds));
            }}
          />
        </div>
        {system === undefined ? null : <p className="hint">{j.memoryInfo(formatMb(system.totalMemoryMb), formatMb(system.freeMemoryMb))}</p>}

        <Toggle
          checked={aikar}
          onChange={(value) => {
            touch();
            setAikar(value);
          }}
          label={j.aikar}
          description={j.aikarHint}
        />

        <div className="space-y-2">
          <Field
            label={j.javaRuntime}
            hint={
              server.requiredJavaMajor === null
                ? j.javaUnknown
                : `${j.javaRequires(javaFit({ major: server.requiredJavaMajor }, requirement).requirement)}${javaPath === '' && automatic !== undefined ? j.javaAutomatic(automatic.major) : ''}`
            }
          >
            {(props) => (
              <select
                {...props}
                className="input"
                value={javaPath}
                onChange={(event) => {
                  touch();
                  setJavaPath(event.target.value);
                }}
              >
                <option value="">{j.automaticOption}</option>
                {runtimes.map((runtime) => {
                  const fit = javaFit(runtime, requirement);
                  return (
                    <option key={runtime.path} value={runtime.path}>
                      Java {runtime.major} ({runtime.version}){runtime.source === 'managed' ? j.fromWorldFoundry : ''} {fit.fits ? j.fits : j.doesNotFit(fit.requirement)}
                    </option>
                  );
                })}
                {javaPath !== '' && !known ? <option value={javaPath}>{j.customPath(javaPath)}</option> : null}
              </select>
            )}
          </Field>
          {runtimes.length === 0 && system !== undefined ? (
            system.javaAutoInstall ? (
              <Notice tone="info">{j.noJavaAuto}</Notice>
            ) : (
              <Notice tone="warn">{j.noJavaManual}</Notice>
            )
          ) : null}
          {javaPath !== '' && known ? <p className="hint break-all">{j.path(javaPath)}</p> : null}
          <Button size="sm" icon={RefreshCw} loading={rescanning} onClick={onRescan}>
            {j.rescan}
          </Button>
        </div>

        <Field label={j.extraArgs} hint={j.extraArgsHint}>
          {(props) => (
            <textarea
              {...props}
              className="input console-body"
              rows={2}
              spellCheck={false}
              maxLength={2000}
              value={args}
              onChange={(event) => {
                touch();
                setArgs(event.target.value);
              }}
            />
          )}
        </Field>

        {error === null ? null : <ErrorNotice error={error} title={j.saveFailed} />}
        {saved ? <Notice tone="success">{t.config.saved}</Notice> : null}
        <Button type="submit" variant="primary" icon={Save} loading={saving} disabled={!dirty || Object.keys(ramErrors).length > 0}>
          {j.save}
        </Button>
      </form>
    </Section>
  );
}

function GeneralSection({ server, onSaved }: { server: ServerView; onSaved: () => void }): ReactNode {
  const { t } = useI18n();
  const g = t.config.general;
  const [name, setName] = useState(server.name);
  const [eula, setEula] = useState(server.eulaAccepted);
  const [autoStart, setAutoStart] = useState(server.autoStart);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setName(server.name);
    setEula(server.eulaAccepted);
    setAutoStart(server.autoStart);
  }, [server.name, server.eulaAccepted, server.autoStart]);

  const trimmed = name.trim();
  const nameError = trimmed === '' ? t.config.validation.nameRequired : trimmed.length > 60 ? t.config.validation.nameTooLong : undefined;
  const patch: UpdateServerInput = {};
  if (trimmed !== server.name && nameError === undefined) patch.name = trimmed;
  if (eula !== server.eulaAccepted) patch.eulaAccepted = eula;
  if (autoStart !== server.autoStart) patch.autoStart = autoStart;
  const dirty = Object.keys(patch).length > 0;

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      await serversApi.update(server.id, patch);
      setSaved(true);
      onSaved();
    } catch (cause) {
      setError(cause);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section title={g.title}>
      <form
        className="space-y-5"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Field label={g.name} error={nameError}>
          {(props) => (
            <input
              {...props}
              className="input"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setSaved(false);
              }}
            />
          )}
        </Field>
        <div className="space-y-2 rounded-lg border border-line-strong bg-canvas p-3">
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{g.eula}</span>
            <span className={server.eulaAccepted ? 'chip chip-ok' : 'chip chip-warn'}>{server.eulaAccepted ? g.accepted : g.notAccepted}</span>
          </p>
          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={eula}
              onChange={(event) => {
                setEula(event.target.checked);
                setSaved(false);
              }}
              className="mt-1 size-5 shrink-0 accent-[var(--color-accent)]"
            />
            <span>
              {g.eulaBefore}{' '}
              <a href={EULA_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1">
                {g.eulaLink}
                <ExternalLink aria-hidden className="size-3" />
              </a>{' '}
              {g.eulaAfter}
            </span>
          </label>
          <p className="hint">{g.eulaHint}</p>
        </div>
        <Toggle
          checked={autoStart}
          onChange={(value) => {
            setAutoStart(value);
            setSaved(false);
          }}
          label={g.autoStart}
          description={g.autoStartHint}
        />
        {error === null ? null : <ErrorNotice error={error} title={g.saveFailed} />}
        {saved ? <Notice tone="success">{t.config.saved}</Notice> : null}
        <Button type="submit" variant="primary" icon={Save} loading={saving} disabled={!dirty}>
          {g.save}
        </Button>
      </form>
    </Section>
  );
}

export function ConfigTab({ server, status }: { server: ServerView; status: RuntimeStatus }): ReactNode {
  const { t } = useI18n();
  const { state, refresh, setRestartNeeded } = useLive();
  const properties = useQuery((signal) => serversApi.properties(server.id, signal), [server.id]);
  // a reload keeps the old data on screen, so sections below do not lose their state while the list is read again
  const rescanRef = useRef(false);
  const [rescanned, setRescanned] = useState(false);
  const system = useQuery((signal) => systemApi.system(rescanRef.current, signal), []);
  const rescanning = system.loading && rescanned;
  const rescan = (): void => {
    rescanRef.current = true;
    setRescanned(true);
    system.reload();
  };

  const afterSave = (restartRequired: boolean): void => {
    if (restartRequired) setRestartNeeded(server.id, true);
    void refresh();
  };
  const view = properties.data;
  const serverNames = new Map((state.servers ?? []).map((entry) => [entry.id, entry.name]));

  return (
    <div className="space-y-4">
      {state.restartNeeded[server.id] === true && status.state !== 'offline' ? (
        <Notice tone="warn" title={t.config.restartNeeded.title}>
          {t.config.restartNeeded.body}
        </Notice>
      ) : null}
      {properties.loading && view === undefined ? (
        <LoadingBlock label={t.config.propertiesLoading} />
      ) : properties.error !== null || view === undefined ? (
        <ErrorNotice error={properties.error ?? new Error(t.config.noData)} title={t.config.propertiesLoadFailed} action={<Button size="sm" onClick={properties.reload}>{t.common.retry}</Button>} />
      ) : (
        <PropertiesSection
          server={server}
          view={view}
          onSaved={(next, restartRequired) => {
            properties.setData(next);
            afterSave(restartRequired);
          }}
        />
      )}
      {system.error !== null ? <ErrorNotice error={system.error} title={t.config.systemDataMissing} action={<Button size="sm" onClick={system.reload}>{t.common.retry}</Button>} /> : null}
      <JvmSection server={server} system={system.data} rescanning={rescanning} onRescan={rescan} onSaved={afterSave} />
      {system.data === undefined ? null : <JavaRuntimes server={server} system={system.data} serverNames={serverNames} onChanged={rescan} />}
      <GeneralSection server={server} onSaved={() => void refresh()} />
      <DeleteServerSection server={server} status={status} />
    </div>
  );
}
