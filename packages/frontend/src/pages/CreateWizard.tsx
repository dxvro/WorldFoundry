import { AlertTriangle, ArrowLeft, ArrowRight, Check, ExternalLink, Rocket, Upload } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { InstallPanel } from '../components/InstallPanel';
import { LOADER_LABEL } from '../components/status';
import { Button, ErrorNotice, Field, LoadingBlock, Notice, Range, Toggle, cx } from '../components/ui';
import { useI18n } from '../i18n';
import { useLive } from '../live/LiveProvider';
import { EULA_URL } from '../lib/constants';
import { systemApi, serversApi } from '../lib/endpoints';
import { formatMb } from '../lib/format';
import { estimateRequiredJava } from '../lib/java';
import { defaultRam, isRamTight, ramBounds, withMax, withMin } from '../lib/ram';
import { Link, serverPath, useRouter } from '../lib/router';
import type { Loader, LoaderInfo, ServerView } from '../lib/types';
import { useQuery } from '../lib/useQuery';
import { NAME_MAX, WIZARD_STEPS, buildRequest, firstInvalidStep, nextFreePort, validateStep, type WizardDraft, type WizardErrors, type WizardStep } from '../lib/wizard';

function StepIndicator({ current, reached }: { current: WizardStep; reached: number }): ReactNode {
  const { t } = useI18n();
  return (
    <ol className="flex flex-wrap gap-x-2 gap-y-1" aria-label={t.wizard.stepsLabel}>
      {WIZARD_STEPS.map((step, index) => {
        const active = step === current;
        const done = index < reached && !active;
        return (
          <li key={step} aria-current={active ? 'step' : undefined} className={cx('flex items-center gap-2 rounded-full px-3 py-1 text-sm', active ? 'bg-accent text-on-accent font-semibold' : done ? 'bg-raised text-ink' : 'text-faint')}>
            <span className="num grid size-5 place-items-center rounded-full border border-current text-xs">{done ? <Check aria-hidden className="size-3" /> : index + 1}</span>
            {t.wizard.steps[step]}
          </li>
        );
      })}
    </ol>
  );
}

function LoaderChoice({ loaders, value, onChange, error }: { loaders: LoaderInfo[]; value: Loader | null; onChange: (loader: Loader) => void; error: string | undefined }): ReactNode {
  const { t } = useI18n();
  return (
    <fieldset className="space-y-2">
      <legend className="label mb-1.5">{t.wizard.loaderLabel}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {loaders.map((loader) => {
          const selected = value === loader.id;
          return (
            <label key={loader.id} className={cx('relative flex cursor-pointer gap-3 rounded-lg border p-3 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent', selected ? 'border-accent bg-accent/8' : 'border-line-strong bg-canvas hover:border-faint')}>
              <input type="radio" name="loader" value={loader.id} checked={selected} onChange={() => onChange(loader.id)} className="mt-0.5 size-5 accent-[var(--color-accent)]" />
              <span className="min-w-0">
                <span className="block font-medium">{LOADER_LABEL[loader.id]}</span>
                <span className="hint block">{t.wizard.loaderHints[loader.id]}</span>
                {loader.requiresInstallerJava ? <span className="hint block">{t.wizard.installerJava}</span> : null}
              </span>
            </label>
          );
        })}
      </div>
      {error === undefined ? null : (
        <p role="alert" className="text-sm text-bad">
          {error}
        </p>
      )}
    </fieldset>
  );
}

function EulaLabel(): ReactNode {
  const { t } = useI18n();
  return (
    <>
      {t.wizard.eulaBefore}{' '}
      <a href={EULA_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1">
        {t.wizard.eulaLink}
        <ExternalLink aria-hidden className="size-3" />
      </a>{' '}
      {t.wizard.eulaAfter}
    </>
  );
}

export function CreateWizard(): ReactNode {
  const { t } = useI18n();
  const { navigate } = useRouter();
  const { state, refresh } = useLive();
  const existing = state.servers ?? [];

  const loaders = useQuery(() => systemApi.loaders(), []);
  const system = useQuery((signal) => systemApi.system(false, signal), []);
  const total = system.data?.totalMemoryMb ?? 0;

  const [step, setStep] = useState<WizardStep>('basics');
  const [reached, setReached] = useState(0);
  const [showErrors, setShowErrors] = useState(false);
  const [snapshots, setSnapshots] = useState(false);
  const [draft, setDraft] = useState<WizardDraft>({
    name: '',
    loader: null,
    mcVersion: '',
    loaderVersion: '',
    port: '',
    minRamMb: 1024,
    maxRamMb: 2048,
    eulaAccepted: false,
  });
  const [portTouched, setPortTouched] = useState(false);
  const [ramTouched, setRamTouched] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<unknown>(null);
  const [created, setCreated] = useState<ServerView | null>(null);

  useEffect(() => {
    document.title = t.wizard.documentTitle;
  }, [t]);

  // sensible defaults once the facts are known, until the user chooses their own values
  useEffect(() => {
    if (!portTouched && state.servers !== null) setDraft((current) => ({ ...current, port: String(nextFreePort(state.servers ?? [])) }));
  }, [portTouched, state.servers]);
  useEffect(() => {
    if (!ramTouched && total > 0) setDraft((current) => ({ ...current, ...defaultRam(total) }));
  }, [ramTouched, total]);

  const mcVersions = useQuery((signal) => systemApi.mcVersions(draft.loader as Loader, snapshots, signal), [draft.loader, snapshots], draft.loader !== null);
  const needsLoaderVersion = draft.loader !== null && draft.loader !== 'vanilla';
  const loaderVersions = useQuery(
    (signal) => systemApi.loaderVersions(draft.loader as Loader, draft.mcVersion, signal),
    [draft.loader, draft.mcVersion],
    needsLoaderVersion && draft.mcVersion !== '',
  );

  // keep the selection valid when the version lists change underneath it
  useEffect(() => {
    const list = mcVersions.data;
    if (list === undefined) return;
    setDraft((current) => (current.mcVersion !== '' && !list.some((entry) => entry.id === current.mcVersion) ? { ...current, mcVersion: '', loaderVersion: '' } : current));
  }, [mcVersions.data]);
  useEffect(() => {
    const list = loaderVersions.data;
    if (list === undefined) return;
    setDraft((current) => {
      if (list.some((entry) => entry.version === current.loaderVersion)) return current;
      const pick = list.find((entry) => entry.recommended) ?? list.find((entry) => entry.stable) ?? list[0];
      return { ...current, loaderVersion: pick?.version ?? '' };
    });
  }, [loaderVersions.data]);

  const context = useMemo(
    () => ({ totalMemoryMb: total, servers: existing, loaderNeedsVersion: needsLoaderVersion }),
    [total, existing, needsLoaderVersion],
  );
  const errors: WizardErrors = validateStep(step, draft, context);
  const visibleErrors: WizardErrors = showErrors ? errors : {};
  const bounds = ramBounds(total > 0 ? total : 2048);
  const stepIndex = WIZARD_STEPS.indexOf(step);

  const update = (patch: Partial<WizardDraft>): void => setDraft((current) => ({ ...current, ...patch }));

  const goNext = (): void => {
    if (Object.keys(errors).length > 0) {
      setShowErrors(true);
      return;
    }
    setShowErrors(false);
    const next = WIZARD_STEPS[stepIndex + 1];
    if (next !== undefined) {
      setStep(next);
      setReached((value) => Math.max(value, stepIndex + 1));
    }
  };
  const goBack = (): void => {
    setShowErrors(false);
    const previous = WIZARD_STEPS[stepIndex - 1];
    if (previous !== undefined) setStep(previous);
  };

  const create = async (): Promise<void> => {
    const invalid = firstInvalidStep(draft, context);
    if (invalid !== null) {
      setStep(invalid);
      setShowErrors(true);
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const server = await serversApi.create(buildRequest(draft));
      setCreated(server);
      void refresh();
    } catch (cause) {
      setCreateError(cause);
    } finally {
      setCreating(false);
    }
  };

  const estimated = draft.mcVersion === '' ? null : estimateRequiredJava(draft.mcVersion);
  const runtimes = system.data?.javaRuntimes;
  const bestJava = runtimes === undefined || runtimes.length === 0 ? null : Math.max(...runtimes.map((runtime) => runtime.major));
  // with automatic installation a missing Java is not a problem; the warning only stays when that is switched off
  const autoJava = system.data?.javaAutoInstall === true;
  const javaMissing = runtimes !== undefined && (runtimes.length === 0 || (estimated !== null && bestJava !== null && bestJava < estimated));

  if (created !== null) {
    const live = existing.find((server) => server.id === created.id) ?? created;
    return (
      <div className="mx-auto max-w-2xl space-y-5">
        <h1 className="text-2xl">
          {live.installState === 'installed' ? t.wizard.installed(live.name) : live.installState === 'failed' ? t.wizard.installFailed(live.name) : t.wizard.installing(live.name)}
        </h1>
        <div className="panel space-y-4 p-4 sm:p-5">
          <InstallPanel server={live} onDone={() => navigate(serverPath(live.id, 'config'))} />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => navigate(serverPath(live.id))}>{t.wizard.openServer}</Button>
          <Button variant="ghost" onClick={() => navigate('/')}>
            {t.shell.toOverview}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <h1 className="text-2xl">{t.wizard.title}</h1>
          <Link to="/new/world" className="link-btn gap-1.5">
            <Upload aria-hidden className="size-4" />
            {t.wizard.fromWorld}
          </Link>
        </div>
        <StepIndicator current={step} reached={reached} />
      </div>

      {loaders.loading || system.loading ? (
        <LoadingBlock />
      ) : loaders.error !== null || loaders.data === undefined ? (
        <ErrorNotice error={loaders.error ?? new Error(t.wizard.loadersFetchFailed)} title={t.wizard.loadersFailed} action={<Button size="sm" onClick={loaders.reload}>{t.common.retry}</Button>} />
      ) : (
        <form
          className="panel space-y-5 p-4 sm:p-5"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (step === 'review') void create();
            else goNext();
          }}
        >
          {system.error !== null ? <ErrorNotice error={system.error} title={t.wizard.systemMissing} action={<Button size="sm" onClick={system.reload}>{t.common.retry}</Button>} /> : null}

          {step === 'basics' ? (
            <>
              <Field label={t.wizard.nameLabel} error={visibleErrors.name} hint={t.wizard.nameHint(NAME_MAX)}>
                {(props) => <input {...props} className="input" value={draft.name} maxLength={NAME_MAX + 20} autoFocus autoComplete="off" onChange={(event) => update({ name: event.target.value })} />}
              </Field>
              <LoaderChoice loaders={loaders.data} value={draft.loader} error={visibleErrors.loader} onChange={(loader) => update({ loader, mcVersion: '', loaderVersion: '' })} />
            </>
          ) : null}

          {step === 'version' ? (
            <>
              <Toggle checked={snapshots} onChange={(value) => setSnapshots(value)} label={t.wizard.showSnapshots} description={t.wizard.snapshotsHint} />
              <Field label={t.wizard.minecraftVersion} error={visibleErrors.mcVersion}>
                {(props) => (
                  <select {...props} className="input" value={draft.mcVersion} disabled={mcVersions.loading} onChange={(event) => update({ mcVersion: event.target.value, loaderVersion: '' })}>
                    <option value="">{mcVersions.loading ? t.common.loading : t.wizard.choose}</option>
                    {(mcVersions.data ?? []).map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.id}
                        {entry.type === 'snapshot' ? t.wizard.snapshotSuffix : ''}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              {mcVersions.error === null ? null : <ErrorNotice error={mcVersions.error} action={<Button size="sm" onClick={mcVersions.reload}>{t.common.retry}</Button>} />}
              {needsLoaderVersion ? (
                <Field label={t.wizard.loaderVersionLabel(draft.loader === null ? t.wizard.loaderLabel : LOADER_LABEL[draft.loader])} error={visibleErrors.loaderVersion}>
                  {(props) => (
                    <select {...props} className="input" value={draft.loaderVersion} disabled={loaderVersions.loading || draft.mcVersion === ''} onChange={(event) => update({ loaderVersion: event.target.value })}>
                      <option value="">{draft.mcVersion === '' ? t.wizard.chooseMinecraftFirst : loaderVersions.loading ? t.common.loading : t.wizard.choose}</option>
                      {(loaderVersions.data ?? []).map((entry) => (
                        <option key={entry.version} value={entry.version}>
                          {entry.version}
                          {entry.recommended ? t.wizard.recommended : entry.stable ? '' : t.wizard.unstable}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
              ) : draft.loader === 'vanilla' ? (
                <p className="hint">{t.wizard.vanillaNoLoaderVersion}</p>
              ) : null}
              {loaderVersions.error === null ? null : <ErrorNotice error={loaderVersions.error} />}
            </>
          ) : null}

          {step === 'resources' ? (
            <>
              <Field label={t.wizard.portLabel} error={visibleErrors.port} hint={t.wizard.portHint}>
                {(props) => (
                  <input
                    {...props}
                    className="input num max-w-40"
                    inputMode="numeric"
                    value={draft.port}
                    onChange={(event) => {
                      setPortTouched(true);
                      update({ port: event.target.value });
                    }}
                  />
                )}
              </Field>
              {total === 0 ? (
                <Notice tone="warn">{t.wizard.memoryUnknown}</Notice>
              ) : (
                <div className="space-y-4">
                  <Range
                    label={t.wizard.minMemory}
                    value={draft.minRamMb}
                    min={bounds.min}
                    max={bounds.max}
                    step={bounds.step}
                    format={formatMb}
                    error={visibleErrors.minRamMb}
                    onChange={(value) => {
                      setRamTouched(true);
                      update(withMin(draft, value, bounds));
                    }}
                  />
                  <Range
                    label={t.wizard.maxMemory}
                    value={draft.maxRamMb}
                    min={bounds.min}
                    max={bounds.max}
                    step={bounds.step}
                    format={formatMb}
                    error={visibleErrors.maxRamMb}
                    onChange={(value) => {
                      setRamTouched(true);
                      update(withMax(draft, value, bounds));
                    }}
                  />
                  <p className="hint">{t.wizard.machineMemory(formatMb(total))}</p>
                  {isRamTight(draft, total) ? <Notice tone="warn">{t.wizard.ramTight}</Notice> : null}
                </div>
              )}
              {autoJava && javaMissing ? (
                <Notice tone="info" title={t.wizard.javaAutoTitle}>
                  {t.wizard.javaAutoText(estimated)}
                </Notice>
              ) : autoJava || runtimes === undefined ? null : runtimes.length === 0 ? (
                <Notice tone="warn" title={t.wizard.noJavaTitle}>
                  {t.wizard.noJavaText(estimated)}
                </Notice>
              ) : estimated !== null && bestJava !== null && bestJava < estimated ? (
                <Notice tone="warn" title={t.wizard.javaTooOldTitle(estimated)}>
                  {t.wizard.javaTooOldText(runtimes.map((runtime) => runtime.major).join(', '))}
                </Notice>
              ) : null}
            </>
          ) : null}

          {step === 'review' ? (
            <>
              <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
                <dt className="text-dim">{t.wizard.fields.name}</dt>
                <dd className="font-medium">{draft.name.trim()}</dd>
                <dt className="text-dim">{t.wizard.fields.loader}</dt>
                <dd>{draft.loader === null ? '–' : LOADER_LABEL[draft.loader]}{draft.loaderVersion === '' ? '' : ` ${draft.loaderVersion}`}</dd>
                <dt className="text-dim">{t.wizard.fields.minecraft}</dt>
                <dd className="num">{draft.mcVersion}</dd>
                <dt className="text-dim">{t.wizard.fields.port}</dt>
                <dd className="num">{draft.port}</dd>
                <dt className="text-dim">{t.wizard.fields.memory}</dt>
                <dd className="num">{t.wizard.memoryRange(formatMb(draft.minRamMb), formatMb(draft.maxRamMb))}</dd>
              </dl>
              <div className="rounded-lg border border-line-strong bg-canvas p-3">
                <label className="flex cursor-pointer items-start gap-3">
                  <input type="checkbox" checked={draft.eulaAccepted} onChange={(event) => update({ eulaAccepted: event.target.checked })} className="mt-1 size-5 shrink-0 accent-[var(--color-accent)]" />
                  <span>
                    <EulaLabel />
                  </span>
                </label>
                <p className="hint mt-2 pl-8">{t.wizard.eulaNotAccepted}</p>
              </div>
              {createError === null ? null : <ErrorNotice error={createError} title={t.wizard.createFailed} />}
            </>
          ) : null}

          <div className="flex flex-wrap justify-between gap-2 border-t border-line pt-4">
            <Button icon={ArrowLeft} onClick={goBack} disabled={stepIndex === 0 || creating}>
              {t.wizard.back}
            </Button>
            {step === 'review' ? (
              <Button type="submit" variant="primary" icon={Rocket} loading={creating}>
                {t.wizard.createServer}
              </Button>
            ) : (
              <Button type="submit" variant="primary" icon={ArrowRight}>
                {t.wizard.next}
              </Button>
            )}
          </div>
          {showErrors && Object.keys(errors).length > 0 ? (
            <p role="alert" className="flex items-center gap-2 text-sm text-bad">
              <AlertTriangle aria-hidden className="size-4" />
              {t.wizard.fixFields}
            </p>
          ) : null}
        </form>
      )}
    </div>
  );
}
