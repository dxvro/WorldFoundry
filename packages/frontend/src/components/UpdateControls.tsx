import { Download } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { renderRef, useI18n } from '../i18n';
import { describeError } from '../lib/api';
import { updateApi } from '../lib/endpoints';
import { plural } from '../lib/format';
import { COUNTDOWN_MAX, STEPS, isRunning, phaseLabel } from '../lib/update';
import type { SystemUpdateState } from '../lib/types';
import { useLive } from '../live/LiveProvider';
import { Dialog } from './Dialog';
import { Button, Notice, ProgressBar, Spinner, cx } from './ui';

export interface UpdateActions {
  busy: boolean;
  error: string | null;
  check: () => Promise<void>;
  apply: (countdownSeconds: number) => Promise<boolean>;
  cancel: () => Promise<void>;
  dismiss: () => Promise<void>;
  setAutoCheck: (value: boolean) => Promise<void>;
}

export function useUpdateActions(): UpdateActions {
  const { setUpdate } = useLive();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(task: () => Promise<SystemUpdateState>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      setUpdate(await task());
      return true;
    } catch (cause) {
      setError(describeError(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }

  return {
    busy,
    error,
    check: async () => void (await run(() => updateApi.check())),
    apply: (countdownSeconds) => run(() => updateApi.apply(countdownSeconds)),
    cancel: async () => void (await run(() => updateApi.cancel())),
    dismiss: async () => void (await run(() => updateApi.dismiss())),
    setAutoCheck: async (value) => void (await run(() => updateApi.setAutoCheck(value))),
  };
}

function runningServerCount(statuses: Record<string, { state: string }>): number {
  return Object.values(statuses).filter((status) => ['online', 'starting', 'preparing'].includes(status.state)).length;
}

interface ApplyProps {
  state: SystemUpdateState;
  actions: UpdateActions;
  size?: 'md' | 'sm';
}

// The button and the confirmation: updating stops every running Minecraft server, so it is never a single click.
export function ApplyUpdate({ state, actions, size = 'md' }: ApplyProps): ReactNode {
  const { t } = useI18n();
  const { state: live } = useLive();
  const [open, setOpen] = useState(false);
  const [countdown, setCountdown] = useState(String(state.countdownSeconds));
  const countdownId = useId();
  const servers = runningServerCount(live.statuses);
  const seconds = Number(countdown);
  const valid = countdown.trim() !== '' && Number.isInteger(seconds) && seconds >= 0 && seconds <= COUNTDOWN_MAX;

  return (
    <>
      <Button variant="primary" size={size} icon={Download} disabled={!state.canApply || isRunning(state)} onClick={() => setOpen(true)}>
        {t.update.applyNow}
      </Button>
      <Dialog
        open={open}
        title={t.update.applyTitle(state.latest?.version ?? '')}
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button onClick={() => setOpen(false)}>{t.common.cancel}</Button>
            <Button
              variant="primary"
              disabled={!valid}
              loading={actions.busy}
              onClick={() => {
                void actions.apply(seconds).then((ok) => {
                  if (ok) setOpen(false);
                });
              }}
            >
              {t.update.applyNow}
            </Button>
          </>
        }
      >
        <Notice tone="warn" title={t.update.stopAllTitle}>
          <p>
            {servers === 0
              ? t.update.noServerRunning
              : t.update.serversRunning(servers, plural(servers, t.update.serverSingular, t.update.serverPlural))}{' '}
            {t.update.applyConsequence}
          </p>
        </Notice>
        <div className="space-y-1.5">
          <label htmlFor={countdownId} className="label block">
            {t.update.countdownLabel}
          </label>
          <input
            id={countdownId}
            type="number"
            min={0}
            max={COUNTDOWN_MAX}
            inputMode="numeric"
            value={countdown}
            onChange={(event) => setCountdown(event.target.value)}
            aria-invalid={valid ? undefined : true}
            className="input w-32"
          />
          <p className="hint">{t.update.countdownHint(COUNTDOWN_MAX)}</p>
        </div>
        {actions.error === null ? null : (
          <Notice tone="error">
            <p>{actions.error}</p>
          </Notice>
        )}
      </Dialog>
    </>
  );
}

export function UpdateProgress({ state, actions, compact = false }: { state: SystemUpdateState; actions?: UpdateActions; compact?: boolean }): ReactNode {
  const { t } = useI18n();
  const index = STEPS.indexOf(state.phase);
  const cancellable = state.phase === 'downloading' || state.phase === 'verifying' || (state.phase === 'waiting-for-servers' && state.progress?.countdownRemaining !== null);
  return (
    <div className="space-y-2" aria-live="polite">
      <p className="flex items-center gap-2 font-medium">
        <Spinner />
        {phaseLabel(state.phase)}
      </p>
      {state.progress === null ? null : <p className="text-dim">{renderRef(state.progress.messageRef, t, state.progress.message)}</p>}
      {state.phase === 'downloading' ? <ProgressBar percent={state.progress?.percent ?? null} label={t.update.downloadLabel} /> : null}
      {compact ? null : (
        <ol className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {STEPS.map((step, position) => (
            <li key={step} className={cx(position < index ? 'text-ok' : position === index ? 'font-medium text-ink' : 'text-faint')} aria-current={position === index ? 'step' : undefined}>
              {position + 1}. {phaseLabel(step)}
            </li>
          ))}
        </ol>
      )}
      {actions !== undefined && cancellable ? (
        <Button size="sm" loading={actions.busy} onClick={() => void actions.cancel()}>
          {t.update.cancelUpdate}
        </Button>
      ) : null}
    </div>
  );
}
