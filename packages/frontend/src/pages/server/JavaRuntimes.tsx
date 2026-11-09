import { Download, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Dialog } from '../../components/Dialog';
import { JavaProgress } from '../../components/JavaProgress';
import { Button, ErrorNotice, Notice, Section, cx } from '../../components/ui';
import { renderOptionalRef, useI18n } from '../../i18n';
import { systemApi } from '../../lib/endpoints';
import { formatBytes, formatDateTime } from '../../lib/format';
import { installMajorFor } from '../../lib/java';
import type { ManagedJavaDto, ServerView, SystemInfo } from '../../lib/types';
import { useLive } from '../../live/LiveProvider';

const OFFERED_MAJORS = [8, 17, 21, 25];

interface Props {
  server: ServerView;
  system: SystemInfo;
  serverNames: ReadonlyMap<string, string>;
  onChanged: () => void;
}

// Everything about the Java versions the app can use: what was found, where it comes from, and the manual
// "install" and "remove" actions for the runtimes WorldFoundry manages itself.
export function JavaRuntimes({ server, system, serverNames, onChanged }: Props): ReactNode {
  const { t } = useI18n();
  const j = t.config.java;
  const { state } = useLive();
  const [installing, setInstalling] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<ManagedJavaDto | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<unknown>(null);

  const managed = new Map(system.managedJava.map((entry) => [entry.javaPath, entry]));
  const installed = new Set(system.managedJava.map((entry) => entry.major));
  const needed = server.requiredJavaMajor === null ? null : installMajorFor(server.requiredJavaMajor, server.loader === 'forge' && server.requiredJavaMajor <= 8 ? 8 : null);
  const offers = [...new Set([...(needed === null ? [] : [needed]), ...OFFERED_MAJORS])].filter((major) => !installed.has(major)).sort((a, b) => a - b);
  const running = new Set<number>([...system.javaInstalls.map((entry) => entry.major), ...Object.entries(state.javaInstalls).filter(([, value]) => value.state === 'running').map(([major]) => Number(major))]);

  const install = async (major: number): Promise<void> => {
    setInstalling(major);
    setError(null);
    setNotice(null);
    try {
      const result = await systemApi.installJava(major);
      setNotice(result.alreadyInstalled ? j.alreadyInstalled(major) : j.installed(major));
      onChanged();
    } catch (cause) {
      setError(cause);
    } finally {
      setInstalling(null);
    }
  };

  const remove = async (): Promise<void> => {
    if (removeTarget === null) return;
    setRemoving(true);
    setRemoveError(null);
    try {
      await systemApi.removeJava(removeTarget.major);
      setNotice(j.removed(removeTarget.major));
      setRemoveTarget(null);
      onChanged();
    } catch (cause) {
      setRemoveError(cause);
    } finally {
      setRemoving(false);
    }
  };

  return (
    <Section
      title={j.title}
      description={system.javaAutoInstall ? j.descriptionAuto : j.descriptionManual}
    >
      <div className="space-y-4">
        {system.javaRuntimes.length === 0 ? (
          <Notice tone={system.javaAutoInstall ? 'info' : 'warn'} title={j.noneFound}>
            {system.javaAutoInstall ? j.noneFoundAuto : j.noneFoundManual}
          </Notice>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line" aria-label={j.listLabel}>
            {system.javaRuntimes.map((runtime) => {
              const entry = managed.get(runtime.path);
              const users = entry?.inUseBy.map((id) => serverNames.get(id) ?? id) ?? [];
              return (
                <li key={runtime.path} className="space-y-1.5 px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{j.javaVersion(runtime.major)}</span>
                    <span className="num text-sm text-dim">{runtime.version}</span>
                    <span className={cx('chip', runtime.source === 'managed' && 'chip-accent')}>{j.source[runtime.source]}</span>
                    {entry === undefined ? null : <span className="chip">{entry.image === 'jre' ? 'JRE' : 'JDK'}</span>}
                    {entry === undefined ? null : <span className="num hint">{formatBytes(entry.sizeBytes)}</span>}
                    {entry === undefined ? null : (
                      <Button
                        size="sm"
                        variant="danger"
                        icon={Trash2}
                        className="ml-auto"
                        disabled={users.length > 0}
                        title={users.length > 0 ? j.usedBy(users.join(', ')) : j.removeTitle(entry.major)}
                        onClick={() => {
                          setRemoveError(null);
                          setRemoveTarget(entry);
                        }}
                      >
                        {j.remove}
                      </Button>
                    )}
                  </div>
                  <p className="break-all font-mono text-xs text-dim">{runtime.path}</p>
                  {runtime.origin === null ? null : <p className="hint">{renderOptionalRef(runtime.originRef, t, runtime.origin)}</p>}
                  {users.length > 0 ? <p className="hint">{j.inUseNow(users.join(', '))}</p> : null}
                </li>
              );
            })}
          </ul>
        )}

        {[...running].map((major) => (
          <JavaProgress key={major} major={major} fallback={system.javaInstalls.find((entry) => entry.major === major) ?? { percent: null, message: null }} />
        ))}

        {offers.length === 0 ? null : (
          <div className="space-y-2">
            <p className="label">{j.installManually}</p>
            <div className="flex flex-wrap gap-2">
              {offers.map((major) => (
                <Button
                  key={major}
                  size="sm"
                  variant={major === needed ? 'primary' : 'secondary'}
                  icon={Download}
                  loading={installing === major}
                  disabled={installing !== null || running.has(major)}
                  onClick={() => void install(major)}
                >
                  {j.install(major)}
                </Button>
              ))}
            </div>
            <p className="hint">
              {needed === null ? '' : j.needs(needed, server.loader === 'forge' && needed <= 8)}
              {j.downloadHint}
            </p>
          </div>
        )}

        {error === null ? null : <ErrorNotice error={error} title={j.installFailed} />}
        {notice === null ? null : <Notice tone="success">{notice}</Notice>}
      </div>

      <Dialog
        open={removeTarget !== null}
        title={j.removeDialogTitle(removeTarget?.major ?? '')}
        onClose={() => setRemoveTarget(null)}
        footer={
          <>
            <Button onClick={() => setRemoveTarget(null)}>{t.common.cancel}</Button>
            <Button variant="danger-solid" icon={Trash2} loading={removing} onClick={() => void remove()}>
              {j.remove}
            </Button>
          </>
        }
      >
        <p>{j.removeBody(removeTarget === null ? '' : formatDateTime(removeTarget.installedAt))}</p>
        {removeError === null ? null : <ErrorNotice error={removeError} />}
      </Dialog>
    </Section>
  );
}
