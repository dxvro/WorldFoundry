import { Rocket } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { InstallPanel } from '../components/InstallPanel';
import { Button, ErrorNotice, Field, Notice } from '../components/ui';
import { GameDisclaimer } from '../games/GameDisclaimer';
import { useI18n } from '../i18n';
import { useLive } from '../live/LiveProvider';
import { serversApi, systemApi } from '../lib/endpoints';
import { serverPath, useRouter } from '../lib/router';
import type { ServerView } from '../lib/types';
import { useQuery } from '../lib/useQuery';

export function SatisfactoryWizard(): ReactNode {
  const { t } = useI18n();
  const s = t.satisfactory;
  const { navigate } = useRouter();
  const { state } = useLive();
  const system = useQuery((signal) => systemApi.system(false, signal), []);
  const [name, setName] = useState('');
  const [branch, setBranch] = useState<'public' | 'experimental'>('public');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [created, setCreated] = useState<ServerView | null>(null);

  useEffect(() => {
    document.title = s.wizardDocumentTitle;
  }, [s]);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (name.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      setCreated(await serversApi.createForGame({ game: 'satisfactory', name: name.trim(), branch }));
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error(String(caught)));
    } finally {
      setBusy(false);
    }
  };

  if (created !== null) {
    const live = (state.servers ?? []).find((server) => server.id === created.id) ?? created;
    return (
      <div className="mx-auto max-w-2xl space-y-5">
        <h1 className="text-2xl">{live.installState === 'installed' ? t.wizard.installed(live.name) : live.installState === 'failed' ? t.wizard.installFailed(live.name) : t.wizard.installing(live.name)}</h1>
        <div className="panel space-y-4 p-4 sm:p-5">
          <InstallPanel server={live} onDone={() => navigate(serverPath(live.id))} />
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
      <div className="space-y-2">
        <h1 className="text-2xl">{s.wizardTitle}</h1>
        <p className="text-dim">{s.wizardIntro}</p>
        <GameDisclaimer game="satisfactory" />
      </div>
      {system.data?.platform === 'linux' ? <Notice tone="info">{s.linuxNote}</Notice> : null}
      {system.data?.platform === 'win32' ? <Notice tone="warn">{s.windowsNote}</Notice> : null}
      <form className="panel space-y-5 p-4 sm:p-5" onSubmit={(event) => void submit(event)} noValidate>
        <Field label={s.name} hint={s.nameHint}>
          {(props) => <input {...props} className="input" value={name} maxLength={60} onChange={(event) => setName(event.target.value)} />}
        </Field>
        <Field label={s.branch} hint={s.branchHint}>
          {(props) => (
            <select {...props} className="input" value={branch} onChange={(event) => setBranch(event.target.value === 'experimental' ? 'experimental' : 'public')}>
              <option value="public">{s.branches.public}</option>
              <option value="experimental">{s.branches.experimental}</option>
            </select>
          )}
        </Field>
        {error === null ? null : <ErrorNotice error={error} />}
        <Button type="submit" variant="primary" icon={Rocket} loading={busy} disabled={name.trim() === ''}>
          {busy ? s.creating : s.create}
        </Button>
      </form>
    </div>
  );
}
