import { CheckCircle2, Download, ExternalLink, OctagonAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { renderOptionalRef, useI18n } from '../i18n';
import { safeHref, SafeMarkdown } from '../lib/markdown';
import { Link, useRouter } from '../lib/router';
import { bannerKind } from '../lib/update';
import { useLive } from '../live/LiveProvider';
import { ApplyUpdate, UpdateProgress, useUpdateActions } from './UpdateControls';
import { Button } from './ui';

// Shown on every page while something about the update is worth knowing: a new version, a running update, its end.
export function UpdateBanner(): ReactNode {
  const { t } = useI18n();
  const { route } = useRouter();
  const { state } = useLive();
  const actions = useUpdateActions();
  const update = state.update;
  const kind = bannerKind(update);
  if (update === null || kind === null) return null;
  // the system page shows everything in full
  if (route.name === 'system') return null;

  if (kind === 'running') {
    return (
      <div role="status" className="border-b border-accent/40 bg-accent/10 px-4 py-3">
        <UpdateProgress state={update} actions={actions} compact />
        <Link to="/system" className="text-sm">
          {t.update.details}
        </Link>
      </div>
    );
  }
  if (kind === 'done' || kind === 'failed') {
    const ok = kind === 'done';
    const Icon = ok ? CheckCircle2 : OctagonAlert;
    return (
      <div role={ok ? 'status' : 'alert'} className={`flex flex-wrap items-center gap-3 border-b px-4 py-3 ${ok ? 'border-ok/40 bg-ok/10' : 'border-bad/50 bg-bad/10'}`}>
        <Icon aria-hidden className={`size-4 shrink-0 ${ok ? 'text-ok' : 'text-bad'}`} />
        <p className="min-w-0 flex-1 text-sm">{ok ? t.update.updatedTo(update.currentVersion) : t.update.failedWith(renderOptionalRef(update.errorRef, t, update.error) ?? t.update.unknownReason)}</p>
        <Button size="sm" variant="ghost" loading={actions.busy} onClick={() => void actions.dismiss()}>
          {t.common.close}
        </Button>
      </div>
    );
  }

  const latest = update.latest;
  if (latest === null) return null;
  const releaseLink = safeHref(latest.htmlUrl);
  return (
    <div role="status" className="border-b border-accent/40 bg-accent/10 px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <Download aria-hidden className="size-4 shrink-0 text-accent" />
        <p className="min-w-0 flex-1 text-sm">
          <strong>{t.update.versionName(latest.version)}</strong> {t.update.availability(latest.prerelease, update.currentVersion)}
        </p>
        {update.canApply ? <ApplyUpdate state={update} actions={actions} size="sm" /> : null}
        {!update.canApply && releaseLink !== null ? (
          <a className="btn btn-sm" href={releaseLink} target="_blank" rel="noopener noreferrer">
            <ExternalLink aria-hidden className="size-4" />
            {t.update.downloadPage}
          </a>
        ) : null}
        <Link to="/system" className="text-sm">
          {t.update.details}
        </Link>
      </div>
      {update.canApply ? null : update.canApplyReason === null ? null : <p className="hint mt-1">{renderOptionalRef(update.canApplyReasonRef, t, update.canApplyReason)}</p>}
      <details className="mt-2">
        <summary className="cursor-pointer text-sm text-dim">{t.update.releaseNotes}</summary>
        <SafeMarkdown source={latest.notes} className="mt-2 max-h-64 space-y-2 overflow-y-auto text-sm text-dim" />
      </details>
    </div>
  );
}
