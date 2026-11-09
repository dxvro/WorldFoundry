import { Download, Play, RotateCw, Skull, Square, X } from 'lucide-react';
import { useCallback, useState, type ReactNode } from 'react';
import { renderOptionalRef, useI18n, type Dictionary } from '../i18n';
import type { MessageRef } from '@worldfoundry/backend/contract';
import { ApiError } from '../lib/api';
import { serversApi, systemApi } from '../lib/endpoints';
import { installMajorFor } from '../lib/java';
import { serverPath, Link } from '../lib/router';
import type { RuntimeStatus, ServerView } from '../lib/types';
import { Dialog } from './Dialog';
import { JavaProgress } from './JavaProgress';
import { Button, ErrorNotice, Notice } from './ui';

export type ServerAction = 'start' | 'stop' | 'restart' | 'kill';

// A start/stop note: its English text and its reference (rendered in the active language)
export interface ActionWarning {
  text: string;
  ref: MessageRef | null;
}

export interface ActionState {
  busy: ServerAction | null;
  error: unknown;
  warnings: ActionWarning[];
  run: (action: ServerAction) => Promise<void>;
  clear: () => void;
}

export function useServerActions(serverId: string): ActionState {
  const [busy, setBusy] = useState<ServerAction | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [warnings, setWarnings] = useState<ActionWarning[]>([]);

  const run = useCallback(
    async (action: ServerAction): Promise<void> => {
      setBusy(action);
      setError(null);
      setWarnings([]);
      try {
        const result: Awaited<ReturnType<(typeof serversApi)[ServerAction]>> = await serversApi[action](serverId);
        if (!('warnings' in result)) {
          setWarnings([]);
        } else {
          const refs = 'warningRefs' in result ? (result.warningRefs as Array<MessageRef | null>) : [];
          setWarnings((result.warnings as string[]).map((text, index) => ({ text, ref: refs[index] ?? null })));
        }
      } catch (cause) {
        setError(cause);
      } finally {
        setBusy(null);
      }
    },
    [serverId],
  );
  const clear = useCallback(() => {
    setError(null);
    setWarnings([]);
  }, []);
  return { busy, error, warnings, run, clear };
}

interface ActionBarProps {
  server: Pick<ServerView, 'id' | 'name' | 'installState'>;
  status: Pick<RuntimeStatus, 'state'>;
  actions: ActionState;
  compact?: boolean;
}

export function ActionBar({ server, status, actions, compact = false }: ActionBarProps): ReactNode {
  const { t } = useI18n();
  const [confirmKill, setConfirmKill] = useState(false);
  const { busy, run } = actions;
  const { state } = status;
  const installed = server.installState === 'installed';
  const active = state === 'preparing' || state === 'starting' || state === 'online' || state === 'stopping';
  const preparing = state === 'preparing';
  const size = compact ? 'sm' : 'md';
  const labels = t.overview.actions;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {active ? null : (
        <Button variant="primary" size={size} icon={Play} loading={busy === 'start'} disabled={!installed || busy !== null} onClick={() => void run('start')}>
          {labels.start}
        </Button>
      )}
      {preparing ? (
        <Button size={size} icon={X} title={labels.cancelStartTitle} loading={busy === 'stop'} disabled={busy !== null} onClick={() => void run('stop')}>
          {t.common.cancel}
        </Button>
      ) : active ? (
        <>
          <Button size={size} icon={Square} loading={busy === 'stop'} disabled={state === 'stopping' || busy !== null} onClick={() => void run('stop')}>
            {labels.stop}
          </Button>
          <Button size={size} icon={RotateCw} loading={busy === 'restart'} disabled={state === 'stopping' || busy !== null} onClick={() => void run('restart')}>
            {labels.restart}
          </Button>
          <Button variant="danger" size={size} icon={Skull} title={labels.killTitle} loading={busy === 'kill'} disabled={busy !== null} onClick={() => setConfirmKill(true)}>
            {labels.kill}
          </Button>
        </>
      ) : null}
      <Dialog
        open={confirmKill}
        title={labels.killConfirmTitle(server.name)}
        onClose={() => setConfirmKill(false)}
        footer={
          <>
            <Button onClick={() => setConfirmKill(false)}>{t.common.cancel}</Button>
            <Button
              variant="danger-solid"
              icon={Skull}
              onClick={() => {
                setConfirmKill(false);
                void run('kill');
              }}
            >
              {labels.killConfirm}
            </Button>
          </>
        }
      >
        <p>{labels.killText}</p>
      </Dialog>
    </div>
  );
}

// A missing or unsuitable Java is fixed by installing the right one, unless the server pins its own path.
function JavaFix({ error, serverId }: { error: ApiError; serverId: string }): ReactNode {
  const { t } = useI18n();
  const details = (error.details ?? {}) as { required?: unknown; requiredMax?: unknown; javaPath?: unknown };
  const pinned = typeof details.javaPath === 'string';
  const required = typeof details.required === 'number' ? details.required : null;
  const major = required === null || pinned ? null : installMajorFor(required, typeof details.requiredMax === 'number' ? details.requiredMax : null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);

  const install = async (): Promise<void> => {
    if (major === null) return;
    setBusy(true);
    setFailure(null);
    try {
      await systemApi.installJava(major);
      setDone(true);
    } catch (cause) {
      setFailure(cause);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      {major === null ? null : done ? (
        <p className="font-medium text-ok">{t.overview.actions.javaInstalled(major)}</p>
      ) : (
        <Button size="sm" variant="primary" icon={Download} loading={busy} onClick={() => void install()}>
          {t.overview.actions.installJava(major)}
        </Button>
      )}
      {busy && major !== null ? <JavaProgress major={major} fallback={{ percent: null, message: null }} /> : null}
      {failure === null ? null : <ErrorNotice error={failure} />}
      <Link to={serverPath(serverId, 'config')} className="link-btn font-medium">
        {pinned ? t.overview.actions.changeJavaPath : t.overview.actions.javaRuntimesConfig}
      </Link>
    </div>
  );
}

// Hints that turn the most common start failures into the next step.
function hintFor(error: unknown, serverId: string, t: Dictionary): ReactNode {
  if (!(error instanceof ApiError)) return undefined;
  if (error.code === 'EULA_NOT_ACCEPTED') {
    return (
      <Link to={serverPath(serverId, 'config')} className="link-btn font-medium">
        {t.overview.actions.toEula}
      </Link>
    );
  }
  if (error.code === 'JAVA_NOT_FOUND' || error.code === 'JAVA_VERSION_INCOMPATIBLE') return <JavaFix error={error} serverId={serverId} />;
  if (error.code === 'PORT_IN_USE') {
    return (
      <Link to={serverPath(serverId, 'config')} className="link-btn font-medium">
        {t.overview.actions.changePort}
      </Link>
    );
  }
  return undefined;
}

export function ActionFeedback({ serverId, actions }: { serverId: string; actions: ActionState }): ReactNode {
  const { t } = useI18n();
  const { error, warnings, clear } = actions;
  if (error === null && warnings.length === 0) return null;
  const hint = hintFor(error, serverId, t);
  return (
    <div className="space-y-2">
      {error === null ? null : (
        <ErrorNotice error={error} {...(hint === undefined ? {} : { action: hint })} />
      )}
      {warnings.length === 0 ? null : (
        <Notice tone="warn" title={t.overview.actions.startNotes}>
          <ul className="list-disc pl-5">
            {warnings.map((warning, index) => (
              <li key={`${index}-${warning.text}`}>{renderOptionalRef(warning.ref, t, warning.text)}</li>
            ))}
          </ul>
        </Notice>
      )}
      <Button variant="ghost" size="sm" onClick={clear}>
        {t.overview.actions.hideMessage}
      </Button>
    </div>
  );
}
