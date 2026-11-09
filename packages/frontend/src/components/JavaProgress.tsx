import type { MessageRef } from '@worldfoundry/backend/contract';
import type { ReactNode } from 'react';
import { renderOptionalRef, renderRef, useI18n } from '../i18n';
import { useLive } from '../live/LiveProvider';
import { ProgressBar, Spinner } from './ui';

interface JavaProgressFallback {
  percent: number | null;
  message: string | null;
  messageRef?: MessageRef | null;
}

// Progress of the installation of a Java runtime, fed by the java.install events (or the state of the system answer).
export function JavaProgress({ major, fallback }: { major: number; fallback?: JavaProgressFallback }): ReactNode {
  const { t } = useI18n();
  const { state } = useLive();
  const live = state.javaInstalls[major];
  const running = live?.state === 'running' ? live : null;
  const percent = running?.percent ?? fallback?.percent ?? null;
  const message =
    running === null
      ? (renderOptionalRef(fallback?.messageRef, t, fallback?.message) ?? null)
      : renderRef(running.messageRef, t, running.message);
  if (running === null && fallback === undefined) return null;
  return (
    <div className="space-y-1.5" aria-live="polite">
      <p className="flex items-center gap-2">
        <Spinner className="text-accent" />
        <span className="font-medium">{message ?? t.overview.javaProgress.installing(major)}</span>
        {percent === null ? null : <span className="num text-dim">{Math.round(percent)} %</span>}
      </p>
      <ProgressBar percent={percent} label={t.overview.javaProgress.label(major)} />
    </div>
  );
}
