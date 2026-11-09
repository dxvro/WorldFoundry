import { ExternalLink, RefreshCw } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { NetworkSection } from '../components/NetworkSettings';
import { PasswordSection } from '../components/PasswordSettings';
import { ApplyUpdate, UpdateProgress, useUpdateActions } from '../components/UpdateControls';
import { Button, ErrorNotice, LoadingBlock, Notice, Section, Toggle } from '../components/ui';
import { renderOptionalRef, useI18n } from '../i18n';
import { formatBytes, formatDateTime } from '../lib/format';
import { safeHref, SafeMarkdown } from '../lib/markdown';
import { isRunning, resultLabel } from '../lib/update';
import type { SystemUpdateState } from '../lib/types';
import { useLive } from '../live/LiveProvider';

function History({ state }: { state: SystemUpdateState }): ReactNode {
  const { t } = useI18n();
  if (state.history.length === 0) return <p className="hint">{t.system.history.empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-dim">
          <tr>
            <th className="py-1 pr-4 font-medium">{t.system.history.when}</th>
            <th className="py-1 pr-4 font-medium">{t.system.history.fromTo}</th>
            <th className="py-1 pr-4 font-medium">{t.system.history.result}</th>
            <th className="py-1 font-medium">{t.system.history.note}</th>
          </tr>
        </thead>
        <tbody>
          {state.history.map((entry) => (
            <tr key={entry.id} className="border-t border-line align-top">
              <td className="num py-1.5 pr-4 whitespace-nowrap">{formatDateTime(entry.finishedAt)}</td>
              <td className="num py-1.5 pr-4 whitespace-nowrap">
                {entry.fromVersion} → {entry.toVersion}
              </td>
              <td className={`py-1.5 pr-4 whitespace-nowrap ${entry.result === 'success' ? 'text-ok' : entry.result === 'cancelled' ? 'text-dim' : 'text-bad'}`}>{resultLabel(entry.result)}</td>
              <td className="py-1.5 text-dim">{renderOptionalRef(entry.messageRef, t, entry.message) ?? '–'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SystemPage(): ReactNode {
  const { t } = useI18n();
  const { state } = useLive();
  const actions = useUpdateActions();
  const update = state.update;

  useEffect(() => {
    document.title = t.system.documentTitle;
  }, [t]);

  // network and password do not depend on the update state; the update sections follow as soon as it is known
  if (update === null) {
    return (
      <div className="space-y-5">
        <h1 className="text-xl">{t.system.title}</h1>
        <NetworkSection />
        <PasswordSection />
        <LoadingBlock label={t.system.loadingUpdate} />
      </div>
    );
  }
  const latest = update.latest;
  const releaseLink = latest === null ? null : safeHref(latest.htmlUrl);

  return (
    <div className="space-y-5">
      <h1 className="text-xl">{t.system.title}</h1>

      {update.phase === 'failed' ? (
        <Notice tone="error" title={t.system.updateFailed} action={<Button size="sm" onClick={() => void actions.dismiss()}>{t.system.understood}</Button>}>
          <p>{renderOptionalRef(update.errorRef, t, update.error) ?? t.update.unknownReason}</p>
        </Notice>
      ) : null}
      {update.phase === 'done' ? (
        <Notice tone="success" title={t.system.updateDone(update.currentVersion)} action={<Button size="sm" onClick={() => void actions.dismiss()}>{t.common.close}</Button>}>
          <p>{t.system.updateDoneText}</p>
        </Notice>
      ) : null}

      <Section title={t.system.version.title} description={t.system.version.description}>
        <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-dim">{t.system.version.installed}</dt>
            <dd className="num text-lg font-semibold">{update.currentVersion}</dd>
          </div>
          <div>
            <dt className="text-dim">{t.system.version.installMode}</dt>
            <dd>{t.system.installMode[update.installMode]}</dd>
          </div>
          <div>
            <dt className="text-dim">{t.system.version.source}</dt>
            <dd className="font-mono">{update.repo}</dd>
          </div>
          <div>
            <dt className="text-dim">{t.system.version.channel}</dt>
            <dd>{update.channel === 'stable' ? t.system.version.stable : t.system.version.prereleases}</dd>
          </div>
        </dl>
        {update.installModeNote === null ? null : (
          <Notice tone="info" className="mt-4">
            <p>{renderOptionalRef(update.installModeNoteRef, t, update.installModeNote)}</p>
          </Notice>
        )}
      </Section>

      <NetworkSection />

      <PasswordSection />

      <Section
        title={t.system.updates.title}
        description={update.lastCheckAt === null ? t.system.updates.notCheckedYet : t.system.updates.lastChecked(formatDateTime(update.lastCheckAt))}
        action={
          <Button icon={RefreshCw} loading={update.checking || actions.busy} disabled={!update.checksEnabled || isRunning(update)} onClick={() => void actions.check()}>
            {t.system.updates.checkNow}
          </Button>
        }
      >
        <div className="space-y-4">
          {!update.checksEnabled ? (
            <Notice tone="warn">
              <p>{t.system.updates.checksDisabled}</p>
            </Notice>
          ) : (
            <Toggle
              checked={update.autoCheck}
              onChange={(value) => void actions.setAutoCheck(value)}
              disabled={actions.busy}
              label={t.system.updates.autoCheck}
              description={t.system.updates.autoCheckDescription}
            />
          )}
          {actions.error === null ? null : <ErrorNotice error={new Error(actions.error)} />}
          {update.lastCheckError === null ? null : (
            <Notice tone="warn" title={t.system.updates.lastCheckFailed}>
              <p>{renderOptionalRef(update.lastCheckErrorRef, t, update.lastCheckError)}</p>
            </Notice>
          )}

          {isRunning(update) ? (
            <div className="rounded-lg border border-line p-3">
              <UpdateProgress state={update} actions={actions} />
            </div>
          ) : latest === null ? (
            <p className="text-dim">{update.lastCheckAt === null ? t.system.updates.checkFirst : t.system.updates.noRelease}</p>
          ) : (
            <div className="space-y-3">
              <p>
                {update.updateAvailable ? (
                  <>
                    {t.system.updates.newVersion} <strong>{t.update.versionName(latest.version)}</strong>
                    {latest.prerelease ? t.system.updates.prerelease : ''}
                    {latest.publishedAt === null ? '' : t.system.updates.publishedAt(formatDateTime(latest.publishedAt))}
                    {latest.assetSizeBytes === null ? '' : `, ${formatBytes(latest.assetSizeBytes)}`}
                  </>
                ) : (
                  t.system.updates.upToDate(latest.version)
                )}
              </p>
              {update.updateAvailable ? (
                <>
                  <div className="flex flex-wrap items-center gap-3">
                    {update.canApply ? <ApplyUpdate state={update} actions={actions} /> : null}
                    {releaseLink === null ? null : (
                      <a className="btn" href={releaseLink} target="_blank" rel="noopener noreferrer">
                        <ExternalLink aria-hidden className="size-4" />
                        {t.system.updates.releaseOnGitHub}
                      </a>
                    )}
                  </div>
                  {update.canApply || update.canApplyReason === null ? null : <p className="hint">{renderOptionalRef(update.canApplyReasonRef, t, update.canApplyReason)}</p>}
                  <div className="rounded-lg border border-line p-3">
                    <h3 className="mb-2 text-sm font-semibold">{t.system.updates.releaseNotes}</h3>
                    <SafeMarkdown source={latest.notes} />
                  </div>
                </>
              ) : null}
            </div>
          )}
        </div>
      </Section>

      <Section title={t.system.history.title} description={t.system.history.description}>
        <History state={update} />
      </Section>
    </div>
  );
}
