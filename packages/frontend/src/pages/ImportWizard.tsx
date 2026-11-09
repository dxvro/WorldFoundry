import { ArrowLeft, Check, ExternalLink, Rocket } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { InstallPanel } from '../components/InstallPanel';
import { LOADER_LABEL } from '../components/status';
import { Button, ErrorNotice, Field, LoadingBlock, Notice, Toggle, cx } from '../components/ui';
import { AnalysisFacts, NoticeList, UploadBox, useImportUpload } from '../components/WorldImport';
import { renderOptionalRef, useI18n } from '../i18n';
import { getCurrentDictionary } from '../i18n/current';
import { isAbort } from '../lib/api';
import { EULA_URL } from '../lib/constants';
import { systemApi } from '../lib/endpoints';
import { formatBytes, formatMb } from '../lib/format';
import { defaultRam } from '../lib/ram';
import { Link, serverPath, useRouter } from '../lib/router';
import type { Loader, ServerView } from '../lib/types';
import { useQuery } from '../lib/useQuery';
import { NAME_MAX } from '../lib/wizard';
import {
  allAcknowledged,
  buildSelection,
  hasBlocker,
  initialChoices,
  matchLabel,
  waitForImport,
  worldApi,
  type Choices,
  type ImportJobView,
  type ImportNoticeView,
  type ImportReview,
  type ModMatchView,
} from '../lib/world';
import { useLive } from '../live/LiveProvider';

type Step = 'archive' | 'review' | 'progress';

function StepIndicator({ current }: { current: Step }): ReactNode {
  const { t } = useI18n();
  const steps: Array<{ id: Step; label: string }> = [
    { id: 'archive', label: t.import.steps.archive },
    { id: 'review', label: t.import.steps.review },
    { id: 'progress', label: t.import.steps.done },
  ];
  const index = steps.findIndex((step) => step.id === current);
  return (
    <ol className="flex flex-wrap gap-x-2 gap-y-1" aria-label={t.wizard.stepsLabel}>
      {steps.map((step, position) => {
        const active = step.id === current;
        const done = position < index;
        return (
          <li key={step.id} aria-current={active ? 'step' : undefined} className={cx('flex items-center gap-2 rounded-full px-3 py-1 text-sm', active ? 'bg-accent text-on-accent font-semibold' : done ? 'bg-raised text-ink' : 'text-faint')}>
            <span className="num grid size-5 place-items-center rounded-full border border-current text-xs">{done ? <Check aria-hidden className="size-3" /> : position + 1}</span>
            {step.label}
          </li>
        );
      })}
    </ol>
  );
}

function ModRow({ match, name, version, fileName, enabled, choice, onChange }: {
  match: ModMatchView;
  enabled: boolean;
  name: string;
  version: string | null;
  fileName: string | null;
  choice: { selected: boolean; candidate: string | null };
  onChange: (next: { selected: boolean; candidate: string | null }) => void;
}): ReactNode {
  const { t } = useI18n();
  const label = matchLabel(match.state);
  const selectable = match.state === 'jar' || match.state === 'jar-known' || match.state === 'found';
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-1 px-3 py-2.5" data-testid="mod-row">
      {selectable ? (
        <input
          type="checkbox"
          aria-label={t.import.takeOver(name)}
          checked={choice.selected}
          onChange={(event) => onChange({ ...choice, selected: event.target.checked })}
          className="mt-0.5 size-5 shrink-0 accent-[var(--color-accent)]"
        />
      ) : (
        <span aria-hidden className="size-5 shrink-0" />
      )}
      <div className="min-w-0 flex-1 basis-48 space-y-0.5">
        <p className="break-words font-medium">
          {name}
          {version === null ? null : <span className="num font-normal text-dim"> {version}</span>}
        </p>
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <span className={cx('chip', label.chip)}>{label.text}</span>
          {enabled ? null : <span className="chip">{t.import.disabled}</span>}
          {match.projectTitle === null ? null : (
            <span className="text-dim">
              {match.projectTitle}
              {match.versionNumber === null ? '' : ` ${match.versionNumber}`}
            </span>
          )}
        </p>
        {fileName === null ? null : <p className="hint break-all">{fileName}</p>}
        {match.state === 'ambiguous' ? (
          <select
            aria-label={t.import.chooseMatch(name)}
            className="input mt-1 max-w-full"
            value={choice.candidate ?? ''}
            onChange={(event) => onChange({ selected: event.target.value !== '', candidate: event.target.value === '' ? null : event.target.value })}
          >
            <option value="">{t.import.notInstall}</option>
            {match.candidates.map((candidate) => (
              <option key={candidate.projectId} value={candidate.projectId}>
                {candidate.title}
              </option>
            ))}
          </select>
        ) : null}
      </div>
    </li>
  );
}

export function ImportWizard(): ReactNode {
  const { t } = useI18n();
  const { navigate } = useRouter();
  const { state, refresh } = useLive();
  const upload = useImportUpload(null);
  const [step, setStep] = useState<Step>('archive');
  const loaders = useQuery(() => systemApi.loaders(), []);
  const system = useQuery((signal) => systemApi.system(false, signal), []);

  const job = upload.job;
  const analysis = job?.status === 'staged' ? job.analysis : null;
  const jobId = job?.id ?? null;

  const [name, setName] = useState('');
  const [loader, setLoader] = useState<Loader | null>(null);
  const [mcVersion, setMcVersion] = useState('');
  const [loaderVersion, setLoaderVersion] = useState('');
  const [snapshots, setSnapshots] = useState(false);
  const [importConfig, setImportConfig] = useState(true);
  const [eula, setEula] = useState(false);
  const [acknowledged, setAcknowledged] = useState<string[]>([]);
  const [choices, setChoices] = useState<Choices>({});
  const [review, setReview] = useState<ImportReview | null>(null);
  const [reviewError, setReviewError] = useState<unknown>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<unknown>(null);
  const [created, setCreated] = useState<{ server: ServerView; job: ImportJobView } | null>(null);
  const [finalJob, setFinalJob] = useState<ImportJobView | null>(null);

  useEffect(() => {
    document.title = t.import.documentTitle;
  }, [t]);

  // the proposal of the analysis fills the choices once per uploaded archive
  useEffect(() => {
    if (analysis === null || jobId === null) return;
    setName((analysis.world.levelName ?? getCurrentDictionary().import.defaultWorldName).slice(0, NAME_MAX));
    setLoader(analysis.proposal.loader);
    setMcVersion(analysis.proposal.mcVersion ?? '');
    setLoaderVersion(analysis.proposal.loaderVersion ?? '');
    setImportConfig(analysis.config.items.length > 0 || analysis.config.properties);
    setAcknowledged([]);
    setStep('review');
  }, [jobId, analysis === null]);

  const mcVersions = useQuery((signal) => systemApi.mcVersions(loader as Loader, snapshots, signal), [loader, snapshots], loader !== null && step === 'review');
  const needsLoaderVersion = loader !== null && loader !== 'vanilla';
  const loaderVersions = useQuery((signal) => systemApi.loaderVersions(loader as Loader, mcVersion, signal), [loader, mcVersion], needsLoaderVersion && mcVersion !== '' && step === 'review');

  // a loader version of another Minecraft version is useless: take the recommended one of the new list
  useEffect(() => {
    const list = loaderVersions.data;
    if (list === undefined) return;
    setLoaderVersion((current) => {
      if (list.some((entry) => entry.version === current)) return current;
      return (list.find((entry) => entry.recommended) ?? list.find((entry) => entry.stable) ?? list[0])?.version ?? '';
    });
  }, [loaderVersions.data]);

  // notices and mod matches depend on the target: ask again whenever it changes
  useEffect(() => {
    if (jobId === null || loader === null || mcVersion === '' || step !== 'review') return;
    const controller = new AbortController();
    setReviewError(null);
    const timer = setTimeout(() => {
      worldApi
        .review(jobId, { loader, mcVersion }, controller.signal)
        .then((result) => {
          setReview(result);
          setChoices(initialChoices(result.matches));
          setAcknowledged([]);
        })
        .catch((cause: unknown) => {
          if (!isAbort(cause)) setReviewError(cause);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [jobId, loader, mcVersion, step]);

  const modByKey = useMemo(() => new Map((analysis?.mods ?? []).map((mod) => [mod.key, mod])), [analysis]);
  const selection = useMemo(() => buildSelection(review?.matches ?? [], choices), [review, choices]);
  const covered = useMemo(() => new Set([...selection.jars, ...selection.install.map((entry) => entry.key)]), [selection]);

  // Mods the world needs that nothing provides: the server repeats this check, the checkbox is its answer
  const missing = useMemo(() => {
    if (analysis === null || !analysis.modded || review === null) return [];
    return review.matches.filter((match) => match.state !== 'client-only' && !covered.has(match.key) && modByKey.get(match.key)?.dir === 'mods');
  }, [analysis, review, covered, modByKey]);

  const notices: ImportNoticeView[] = useMemo(() => {
    const list = [...(analysis?.notices ?? []), ...(review?.notices ?? [])];
    const unique = list.filter((notice, index) => list.findIndex((other) => other.code === notice.code) === index);
    if (missing.length > 0 && loader !== null && loader !== 'vanilla') {
      unique.push({
        code: 'MODS_MISSING',
        level: 'warn',
        needsConfirm: true,
        text: t.import.missingMods(missing.map((match) => modByKey.get(match.key)?.name ?? match.key).join(', ')),
      });
    }
    return unique;
  }, [analysis, review, missing, modByKey, loader, t]);

  const total = system.data?.totalMemoryMb ?? 0;
  const ready =
    analysis !== null &&
    review !== null &&
    name.trim() !== '' &&
    name.trim().length <= NAME_MAX &&
    loader !== null &&
    mcVersion !== '' &&
    (!needsLoaderVersion || loaderVersion !== '') &&
    !hasBlocker(notices) &&
    allAcknowledged(notices, acknowledged);

  const create = async (): Promise<void> => {
    if (jobId === null || loader === null || !ready) return;
    setCreating(true);
    setCreateError(null);
    try {
      const ram = total > 0 ? defaultRam(total) : null;
      const result = await worldApi.createServer(jobId, {
        server: {
          name: name.trim(),
          loader,
          mcVersion,
          ...(needsLoaderVersion ? { loaderVersion } : {}),
          ...(ram === null ? {} : { minRamMb: ram.minRamMb, maxRamMb: ram.maxRamMb }),
          eulaAccepted: eula,
        },
        importConfig,
        selection,
        acknowledged,
      });
      setCreated({ server: result.server as unknown as ServerView, job: result.import });
      setStep('progress');
      void refresh();
      void waitForImport(jobId, (update) => setFinalJob(update)).catch(() => undefined);
    } catch (cause) {
      setCreateError(cause);
    } finally {
      setCreating(false);
    }
  };

  if (step === 'progress' && created !== null) {
    const live = state.servers?.find((server) => server.id === created.server.id) ?? created.server;
    const current = finalJob ?? created.job;
    const result = current.result;
    return (
      <div className="mx-auto max-w-2xl space-y-5">
        <h1 className="text-2xl">{current.status === 'done' ? t.import.created(live.name) : current.status === 'failed' ? t.import.importIncomplete(live.name) : t.import.creating(live.name)}</h1>
        <StepIndicator current="progress" />
        <div className="panel space-y-4 p-4 sm:p-5">
          {current.status === 'failed' ? (
            <Notice tone="error" title={t.import.importNotComplete}>
              {renderOptionalRef(current.errorRef, t, current.error)}
            </Notice>
          ) : current.status === 'done' ? (
            <Notice tone={result !== null && (result.modsFailed.length > 0 || result.warnings.length > 0) ? 'warn' : 'success'} title={t.import.importDone}>
              {result === null ? null : (
                <ul className="list-disc pl-5">
                  <li>
                    {t.import.folders}: {result.folders.join(', ')}
                  </li>
                  {result.jarsPlaced.length > 0 ? (
                    <li>
                      {t.import.jarsPlaced}: {result.jarsPlaced.length}
                    </li>
                  ) : null}
                  {result.modsInstalled.length > 0 ? (
                    <li>
                      {t.import.installedFromModrinth}: {result.modsInstalled.join(', ')}
                    </li>
                  ) : null}
                  {result.modsFailed.map((entry) => (
                    <li key={entry.name} className="text-bad">
                      {entry.name}: {renderOptionalRef(entry.reasonRef, t, entry.reason)}
                    </li>
                  ))}
                  {result.warnings.map((warning, index) => (
                    <li key={`${index}-${warning}`}>{renderOptionalRef(result.warningRefs?.[index], t, warning)}</li>
                  ))}
                </ul>
              )}
            </Notice>
          ) : (
            <p role="status" className="text-dim">
              {renderOptionalRef(current.messageRef, t, current.message) ?? t.import.worldBeingImported} …
            </p>
          )}
          <InstallPanel server={live} />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => navigate(serverPath(live.id, 'config'))}>
            {t.wizard.openServer}
          </Button>
          <Button variant="ghost" onClick={() => navigate('/')}>
            {t.shell.toOverview}
          </Button>
        </div>
      </div>
    );
  }

  const versionOptions = mcVersions.data ?? [];
  const withCurrent = mcVersion !== '' && !versionOptions.some((entry) => entry.id === mcVersion) ? [{ id: mcVersion, type: 'release' as const }, ...versionOptions] : versionOptions;

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <Link to="/new" className="link-btn gap-1.5 text-dim no-underline hover:text-ink">
        <ArrowLeft aria-hidden className="size-4" />
        {t.import.backToWizard}
      </Link>
      <div className="space-y-3">
        <h1 className="text-2xl">{t.import.title}</h1>
        <StepIndicator current={step} />
      </div>

      {step === 'archive' || analysis === null ? (
        <div className="panel space-y-4 p-4 sm:p-5">
          <p className="text-dim">{t.import.intro}</p>
          <UploadBox upload={upload} />
        </div>
      ) : (
        <form
          className="panel space-y-6 p-4 sm:p-5"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <section aria-label={t.import.detectedWorld} className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-base">{t.import.archiveContains}</h2>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  upload.reset();
                  setReview(null);
                  setStep('archive');
                }}
              >
                {t.import.otherArchive}
              </Button>
            </div>
            <AnalysisFacts analysis={analysis} />
            {analysis.proposal.evidence.length === 0 ? null : (
              <details className="text-sm text-dim">
                <summary className="cursor-pointer">{t.import.loaderEvidence}</summary>
                <ul className="mt-1 list-disc pl-5">
                  {analysis.proposal.evidence.map((line, index) => (
                    <li key={`${index}-${line}`}>{renderOptionalRef(analysis.proposal.evidenceRefs?.[index], t, line)}</li>
                  ))}
                </ul>
              </details>
            )}
          </section>

          <section aria-label={t.import.serverSection} className="space-y-4">
            <h2 className="text-base">{t.import.newServer}</h2>
            <Field
              label={t.wizard.nameLabel}
              hint={t.wizard.nameHint(NAME_MAX)}
              error={name.trim() === '' ? t.wizard.validation.nameMissing : name.trim().length > NAME_MAX ? t.wizard.validation.nameTooLong(NAME_MAX) : undefined}
            >
              {(props) => <input {...props} className="input" value={name} autoComplete="off" onChange={(event) => setName(event.target.value)} />}
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t.wizard.loaderLabel}>
                {(props) => (
                  <select
                    {...props}
                    className="input"
                    value={loader ?? ''}
                    onChange={(event) => {
                      setLoader(event.target.value as Loader);
                      setLoaderVersion('');
                    }}
                  >
                    {(loaders.data ?? []).map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {LOADER_LABEL[entry.id]}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label={t.wizard.minecraftVersion} hint={analysis.version.preOneNine ? t.import.preOneNine : undefined}>
                {(props) => (
                  <select {...props} className="input" value={mcVersion} disabled={mcVersions.loading} onChange={(event) => setMcVersion(event.target.value)}>
                    <option value="">{mcVersions.loading ? t.common.loading : t.wizard.choose}</option>
                    {withCurrent.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.id}
                        {entry.type === 'snapshot' ? t.wizard.snapshotSuffix : ''}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            </div>
            {needsLoaderVersion ? (
              <Field label={t.wizard.loaderVersionLabel(loader === null ? t.wizard.loaderLabel : LOADER_LABEL[loader])}>
                {(props) => (
                  <select {...props} className="input" value={loaderVersion} disabled={loaderVersions.loading || mcVersion === ''} onChange={(event) => setLoaderVersion(event.target.value)}>
                    <option value="">{mcVersion === '' ? t.wizard.chooseMinecraftFirst : loaderVersions.loading ? t.common.loading : t.wizard.choose}</option>
                    {(loaderVersions.data ?? []).map((entry) => (
                      <option key={entry.version} value={entry.version}>
                        {entry.version}
                        {entry.recommended ? t.wizard.recommended : entry.stable ? '' : t.wizard.unstable}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            ) : null}
            {loaderVersions.error === null ? null : <ErrorNotice error={loaderVersions.error} />}
            <Toggle checked={snapshots} onChange={setSnapshots} label={t.wizard.showSnapshots} description={t.import.snapshotsHint} />
            {analysis.config.items.length > 0 || analysis.config.properties ? (
              <Toggle checked={importConfig} onChange={setImportConfig} label={t.import.configTitle} description={t.import.configDescription(analysis.config.items.join(', '))} />
            ) : null}
          </section>

          {analysis.mods.length === 0 ? null : (
            <section aria-label={t.import.modsLabel} className="space-y-2">
              <h2 className="text-base">{t.import.modsSection}</h2>
              {review === null && reviewError === null ? (
                <LoadingBlock label={t.import.checkingMods} />
              ) : (
                <>
                  {review?.modrinthAvailable === false ? <Notice tone="warn">{t.import.modrinthUnreachable}</Notice> : null}
                  <ul className="divide-y divide-line rounded-lg border border-line">
                    {(review?.matches ?? []).map((match) => {
                      const mod = modByKey.get(match.key);
                      if (mod === undefined) return null;
                      return (
                        <ModRow
                          key={match.key}
                          match={match}
                          name={mod.name}
                          version={mod.version}
                          fileName={mod.fileName}
                          enabled={mod.enabled}
                          choice={choices[match.key] ?? { selected: false, candidate: null }}
                          onChange={(next) => setChoices((current) => ({ ...current, [match.key]: next }))}
                        />
                      );
                    })}
                  </ul>
                </>
              )}
            </section>
          )}
          {reviewError === null ? null : <ErrorNotice error={reviewError} title={t.import.reviewFailed} />}

          <section aria-label={t.import.noticesLabel} className="space-y-2">
            <NoticeList
              notices={notices}
              acknowledged={acknowledged}
              onToggle={(code, checked) => setAcknowledged((current) => (checked ? [...current, code] : current.filter((entry) => entry !== code)))}
            />
          </section>

          <div className="rounded-lg border border-line-strong bg-canvas p-3">
            <label className="flex cursor-pointer items-start gap-3">
              <input type="checkbox" checked={eula} onChange={(event) => setEula(event.target.checked)} className="mt-1 size-5 shrink-0 accent-[var(--color-accent)]" />
              <span>
                {t.wizard.eulaBefore}{' '}
                <a href={EULA_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1">
                  {t.wizard.eulaLink}
                  <ExternalLink aria-hidden className="size-3" />
                </a>{' '}
                {t.wizard.eulaAfter}
              </span>
            </label>
            <p className="hint mt-2 pl-8">{t.import.eulaHint}</p>
          </div>

          {createError === null ? null : <ErrorNotice error={createError} title={t.wizard.createFailed} />}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-4">
            <p className="hint">
              {total > 0 && analysis !== null ? t.import.ramNote(formatMb(defaultRam(total).minRamMb), formatMb(defaultRam(total).maxRamMb)) : ''}
              {t.import.archiveSize(formatBytes(analysis.archive.sizeBytes))}
            </p>
            <Button type="submit" variant="primary" icon={Rocket} loading={creating} disabled={!ready}>
              {t.wizard.createServer}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
