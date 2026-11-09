import { Network, Power, RotateCcw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { renderOptionalRef, renderRef, useI18n } from '../i18n';
import { describeError } from '../lib/api';
import { networkApi } from '../lib/endpoints';
import { plural } from '../lib/format';
import type { NetworkState, RestartPlan } from '../lib/types';
import { useQuery } from '../lib/useQuery';
import { useLive } from '../live/LiveProvider';
import { Dialog } from './Dialog';
import { Button, ErrorNotice, Field, LoadingBlock, Notice, Section, Spinner } from './ui';

const ALL = '0.0.0.0';
const LOOPBACK = '127.0.0.1';

interface Draft {
  bindHost: string;
  port: string;
  hosts: string;
  publicAddress: string;
}

function draftOf(state: NetworkState): Draft {
  return {
    bindHost: state.settings.bindHost ?? state.defaults.host,
    port: String(state.settings.port ?? state.defaults.port),
    hosts: state.settings.allowedHosts.join('\n'),
    publicAddress: state.settings.publicAddress ?? '',
  };
}

const splitHosts = (text: string): string[] =>
  text
    .split(/[\s,;]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');

function UrlList({ urls }: { urls: string[] }): ReactNode {
  const { t } = useI18n();
  if (urls.length === 0) return <p className="text-dim">{t.network.noAddress}</p>;
  return (
    <ul className="space-y-1">
      {urls.map((url) => (
        <li key={url}>
          <a href={url} className="num break-all font-mono text-base text-accent">
            {url}
          </a>
        </li>
      ))}
    </ul>
  );
}

// Polls until the restarted application answers, then moves the browser there. The old process has to go away first,
// otherwise the page would "find" the application that is just shutting down.
function useRestartRedirect(plan: RestartPlan | null): { waited: number; reachable: string | null } {
  const [waited, setWaited] = useState(0);
  const [reachable, setReachable] = useState<string | null>(null);
  useEffect(() => {
    if (plan === null) return;
    let cancelled = false;
    const started = Date.now();
    const sameHost = (url: string): boolean => {
      try {
        return new URL(url).hostname === window.location.hostname;
      } catch {
        return false;
      }
    };
    // addresses on the host name the page was opened with come first, they are the ones that certainly work for this browser
    const targets = [...plan.urls].sort((a, b) => Number(sameHost(b)) - Number(sameHost(a)));
    const answers = async (url: string): Promise<boolean> => {
      try {
        const response = await fetch(`${url}/api/health`, { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(2500) });
        return response.type === 'opaque' || response.ok;
      } catch {
        return false;
      }
    };
    const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    void (async () => {
      // 1. the current process goes down (or it is still the same after 30 s: then it was a very quick restart)
      while (!cancelled && Date.now() - started < 30_000) {
        if (!(await answers(window.location.origin))) break;
        await wait(700);
      }
      // 2. the new one answers on one of the addresses
      while (!cancelled && Date.now() - started < 10 * 60_000) {
        setWaited(Math.round((Date.now() - started) / 1000));
        for (const url of targets) {
          if (await answers(url)) {
            if (cancelled) return;
            setReachable(url);
            await wait(400);
            window.location.assign(`${url}/system`);
            return;
          }
        }
        await wait(2000);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [plan]);
  return { waited, reachable };
}

function Restarting({ plan }: { plan: RestartPlan }): ReactNode {
  const { t } = useI18n();
  const { waited, reachable } = useRestartRedirect(plan);
  return (
    <div className="space-y-3" role="status" aria-live="polite">
      <p className="flex items-center gap-2 font-medium">
        <Spinner />
        {reachable !== null ? t.network.restartingLive : plan.automatic ? t.network.restartingAutomatic : t.network.restartStopped}
      </p>
      {plan.automatic ? (
        <p className="text-dim">{t.network.restartWaitsAutomatic}</p>
      ) : (
        <Notice tone="warn" title={t.network.restartManualTitle}>
          <p>
            {renderRef(plan.noteRef, t, plan.note)} {t.network.restartManualAfter}
          </p>
        </Notice>
      )}
      <div>
        <p className="mb-1 text-dim">{t.network.reachableAt}</p>
        <UrlList urls={plan.urls} />
      </div>
      {waited > 90 ? <p className="hint">{t.network.stillWaiting}</p> : null}
    </div>
  );
}

function RestartButton({ state, onRestarting }: { state: NetworkState; onRestarting: (plan: RestartPlan) => void }): ReactNode {
  const { t } = useI18n();
  const { state: live } = useLive();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = Object.values(live.statuses).filter((status) => ['online', 'starting', 'preparing'].includes(status.state)).length;
  const newUrls = state.pending.urls;

  return (
    <>
      <Button variant="primary" icon={Power} onClick={() => setOpen(true)}>
        {t.network.restartNow}
      </Button>
      <Dialog
        open={open}
        title={t.network.restartTitle}
        onClose={() => (busy ? undefined : setOpen(false))}
        footer={
          <>
            <Button onClick={() => setOpen(false)} disabled={busy}>
              {t.common.cancel}
            </Button>
            <Button
              variant="primary"
              loading={busy}
              onClick={() => {
                setBusy(true);
                setError(null);
                networkApi.restart().then(
                  (plan) => {
                    setBusy(false);
                    setOpen(false);
                    onRestarting(plan);
                  },
                  (cause: unknown) => {
                    setBusy(false);
                    setError(describeError(cause));
                  },
                );
              }}
            >
              {t.network.restartNow}
            </Button>
          </>
        }
      >
        <Notice tone="warn" title={t.network.stopAllTitle}>
          <p>
            {running === 0 ? t.network.noServerRunning : t.network.serversRunning(running, plural(running, t.network.serverSingular, t.network.serverPlural))}{' '}
            {t.network.restartConsequence} {renderRef(state.restart.noteRef, t, state.restart.note)}
          </p>
        </Notice>
        <div>
          <p className="mb-1 text-dim">{t.network.reachableAfterRestart}</p>
          <UrlList urls={newUrls} />
        </div>
        {error === null ? null : (
          <Notice tone="error">
            <p>{error}</p>
          </Notice>
        )}
      </Dialog>
    </>
  );
}

export function NetworkSection(): ReactNode {
  const { t } = useI18n();
  const query = useQuery((signal) => networkApi.state(signal), []);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const [plan, setPlan] = useState<RestartPlan | null>(null);
  const loadedFor = useRef<NetworkState | undefined>(undefined);
  const state = query.data;

  // the form starts from the stored values whenever fresh state arrives and the user has not typed anything yet
  useEffect(() => {
    if (state !== undefined && loadedFor.current !== state) {
      loadedFor.current = state;
      setDraft(draftOf(state));
    }
  }, [state]);

  const options = useMemo(() => {
    if (state === undefined) return [];
    const list: Array<{ value: string; label: string; group: 'main' | 'virtual' }> = [
      { value: ALL, label: t.network.anyAdapter, group: 'main' },
      ...state.lan.map((entry) => ({ value: entry.address, label: t.network.adapter(entry.address, entry.interfaceName), group: 'main' as const })),
      { value: LOOPBACK, label: t.network.loopbackOnly, group: 'main' },
      ...state.virtual.map((entry) => ({ value: entry.address, label: t.network.vpnAdapter(entry.address, entry.interfaceName), group: 'virtual' as const })),
    ];
    const known = new Set(list.map((entry) => entry.value));
    for (const value of [state.settings.bindHost, state.defaults.host, state.active.host]) {
      if (value !== null && !known.has(value)) {
        known.add(value);
        list.push({ value, label: t.network.notPresent(value), group: 'main' });
      }
    }
    return list;
  }, [state, t]);

  if (plan !== null) {
    return (
      <Section title={t.network.title} description={t.network.restartRunning}>
        <Restarting plan={plan} />
      </Section>
    );
  }
  if (query.loading && state === undefined) return <LoadingBlock label={t.network.checking} />;
  if (state === undefined || draft === null) {
    return (
      <Section title={t.network.title}>
        <ErrorNotice error={query.error ?? new Error(t.network.loadFailed)} action={<Button size="sm" onClick={query.reload}>{t.common.retry}</Button>} />
      </Section>
    );
  }

  const current = draftOf(state);
  const dirty = draft.bindHost !== current.bindHost || draft.port !== current.port || draft.hosts !== current.hosts || draft.publicAddress !== current.publicAddress;
  const portNumber = Number(draft.port);
  const portValid = draft.port.trim() !== '' && Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535;
  const hasStored = state.settings.bindHost !== null || state.settings.port !== null || state.settings.allowedHosts.length > 0 || state.settings.publicAddress !== null;
  const portChanges = state.pending.port !== state.active.port;
  const set = (patch: Partial<Draft>): void => {
    setDraft({ ...draft, ...patch });
    setSaved(false);
  };

  const save = async (input: Parameters<typeof networkApi.save>[0]): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const next = await networkApi.save(input);
      query.setData(next);
      loadedFor.current = next;
      setDraft(draftOf(next));
      setSaved(true);
    } catch (cause) {
      setError(cause);
    } finally {
      setSaving(false);
    }
  };

  const submit = (): void => {
    if (!portValid) return;
    void save({
      bindHost: draft.bindHost === state.defaults.host ? null : draft.bindHost,
      port: portNumber === state.defaults.port ? null : portNumber,
      allowedHosts: splitHosts(draft.hosts),
      publicAddress: draft.publicAddress.trim() === '' ? null : draft.publicAddress.trim(),
    });
  };

  const activeUrls = state.active.urls;
  const showHostname = state.active.host === ALL;

  return (
    <Section title={t.network.title} description={t.network.description}>
      <div className="space-y-5">
        {state.warnings.map((warning, index) => (
          <Notice key={`${index}-${warning}`} tone="warn" title={t.network.warningTitle}>
            <p>{renderOptionalRef(state.warningRefs?.[index], t, warning)}</p>
          </Notice>
        ))}

        <div className="space-y-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <Network aria-hidden className="size-4 text-accent" />
            {t.network.reachableNow}
          </h3>
          {state.active.host === LOOPBACK ? (
            <Notice tone="info">
              <p>{t.network.loopbackNotice}</p>
            </Notice>
          ) : null}
          <UrlList urls={showHostname ? [...activeUrls, state.hostnameUrl] : activeUrls} />
          {state.publicUrl === null ? null : (
            <p className="text-dim">
              {t.network.publicAddress} <span className="num break-all font-mono text-ink">{state.publicUrl}</span>
            </p>
          )}
          {state.virtual.length > 0 ? (
            <details className="text-sm text-dim">
              <summary className="min-h-8 cursor-pointer py-1">{t.network.vpnSummary(state.virtual.length)}</summary>
              <ul className="mt-1 space-y-1 pl-4">
                {state.virtual.map((entry) => (
                  <li key={`${entry.interfaceName}-${entry.address}`} className="break-words">
                    <span className="num font-mono text-ink">{entry.url}</span> <span className="text-faint">[{entry.interfaceName}]</span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          <p className="hint">{t.network.staticIpHint}</p>
        </div>

        <form
          className="space-y-4 border-t border-line pt-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <h3 className="text-sm font-semibold">{t.network.settings}</h3>
          <Field label={t.network.bindTo} hint={t.network.bindHint}>
            {(props) => (
              <select {...props} className="input" value={draft.bindHost} onChange={(event) => set({ bindHost: event.target.value })}>
                {options
                  .filter((option) => option.group === 'main')
                  .map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                {options.some((option) => option.group === 'virtual') ? (
                  <optgroup label={t.network.vpnGroup}>
                    {options
                      .filter((option) => option.group === 'virtual')
                      .map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                  </optgroup>
                ) : null}
              </select>
            )}
          </Field>
          <Field label={t.network.webPort} hint={t.network.webPortHint(state.defaults.port)} error={draft.port.trim() !== '' && !portValid ? t.network.portInvalid : undefined}>
            {(props) => <input {...props} className="input w-40" type="number" inputMode="numeric" min={1} max={65535} value={draft.port} onChange={(event) => set({ port: event.target.value })} />}
          </Field>
          <Field
            label={t.network.allowedHosts}
            hint={
              <>
                {t.network.allowedHostsHint}
                {state.defaults.allowedHosts.length > 0 ? t.network.allowedHostsDefault(state.defaults.allowedHosts.join(', ')) : ''}
              </>
            }
          >
            {(props) => <textarea {...props} className="input font-mono" rows={3} spellCheck={false} placeholder="minecraft.fritz.box" value={draft.hosts} onChange={(event) => set({ hosts: event.target.value })} />}
          </Field>
          <Field label={t.network.publicAddressLabel} hint={t.network.publicAddressHint}>
            {(props) => <input {...props} className="input" type="text" spellCheck={false} placeholder="minecraft.fritz.box:3000" value={draft.publicAddress} onChange={(event) => set({ publicAddress: event.target.value })} />}
          </Field>
          {error === null ? null : <ErrorNotice error={error} />}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" loading={saving} disabled={!dirty || !portValid}>
              {t.network.save}
            </Button>
            {hasStored ? (
              <Button icon={RotateCcw} disabled={saving} onClick={() => void save({ bindHost: null, port: null, allowedHosts: [], publicAddress: null })}>
                {t.network.resetDefaults}
              </Button>
            ) : null}
          </div>
        </form>

        {state.restartRequired ? (
          <Notice tone="info" title={saved ? t.network.savedRestart : t.network.restartRequired} action={<RestartButton state={state} onRestarting={setPlan} />}>
            <p>{t.network.reachableAfterRestart}</p>
            <div className="mt-1">
              <UrlList urls={[...(state.publicUrl === null ? [] : [state.publicUrl]), ...state.pending.urls, ...(state.pending.host === ALL ? [`http://${state.hostname}:${state.pending.port}`] : [])]} />
            </div>
            {portChanges ? <p className="hint mt-2">{t.network.portChanged(state.pending.port)}</p> : null}
            {state.restart.automatic ? null : <p className="hint mt-2">{renderRef(state.restart.noteRef, t, state.restart.note)}</p>}
          </Notice>
        ) : null}
      </div>
    </Section>
  );
}
