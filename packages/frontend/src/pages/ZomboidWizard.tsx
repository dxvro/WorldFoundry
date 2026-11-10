import { Rocket } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { InstallPanel } from '../components/InstallPanel';
import { Button, ErrorNotice, Field, Notice, Range } from '../components/ui';
import { GameDisclaimer } from '../games/GameDisclaimer';
import { useI18n } from '../i18n';
import { useLive } from '../live/LiveProvider';
import { serversApi, systemApi } from '../lib/endpoints';
import type { ServerView } from '../lib/types';
import { formatMb } from '../lib/format';
import { serverPath, useRouter } from '../lib/router';
import { useQuery } from '../lib/useQuery';

const PROFILE = /^[A-Za-z0-9_-]{1,64}$/;
const BRANCH = /^[A-Za-z0-9_.-]{1,80}$/;

// Creating a Project Zomboid server: one form, then the SteamCMD installation in the background.
export function ZomboidWizard(): ReactNode {
  const { t } = useI18n();
  const z = t.zomboid;
  const { navigate } = useRouter();
  const { state } = useLive();
  const system = useQuery((signal) => systemApi.system(false, signal), []);
  const [name, setName] = useState('');
  const [profile, setProfile] = useState('servertest');
  const [branch, setBranch] = useState('public');
  const [memory, setMemory] = useState(4096);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [created, setCreated] = useState<ServerView | null>(null);

  useEffect(() => {
    document.title = z.wizardDocumentTitle;
  }, [z]);

  const total = system.data?.totalMemoryMb ?? 16_384;
  const max = Math.max(1024, Math.floor(total / 512) * 512);
  const errors = {
    name: name.trim() === '' ? t.wizard.validation.nameMissing : undefined,
    profile: PROFILE.test(profile) ? undefined : z.profileInvalid,
    branch: BRANCH.test(branch) && !branch.startsWith('-') ? undefined : z.branchInvalid,
  };
  const valid = Object.values(errors).every((value) => value === undefined);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      setCreated(await serversApi.createForGame({ game: 'zomboid', name: name.trim(), profile, branch, maxRamMb: Math.min(memory, max) }));
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
        <h1 className="text-2xl">{z.wizardTitle}</h1>
        <p className="text-dim">{z.wizardIntro}</p>
        <GameDisclaimer game="zomboid" />
      </div>
      {system.data?.platform === 'linux' ? <Notice tone="info">{z.linuxNote}</Notice> : null}
      <form className="panel space-y-5 p-4 sm:p-5" onSubmit={(event) => void submit(event)} noValidate>
        <Field label={z.name} hint={z.nameHint} error={name === '' ? undefined : errors.name}>
          {(props) => <input {...props} className="input" value={name} maxLength={60} onChange={(event) => setName(event.target.value)} />}
        </Field>
        <Field label={z.profile} hint={z.profileHint} error={errors.profile}>
          {(props) => <input {...props} className="input num" value={profile} maxLength={64} onChange={(event) => setProfile(event.target.value)} />}
        </Field>
        <Field label={z.branch} hint={z.branchHint} error={errors.branch}>
          {(props) => <input {...props} className="input num" value={branch} maxLength={80} onChange={(event) => setBranch(event.target.value)} />}
        </Field>
        <Range label={z.memory} value={Math.min(memory, max)} min={1024} max={max} step={512} onChange={setMemory} format={formatMb} />
        {error === null ? null : <ErrorNotice error={error} />}
        <Button type="submit" variant="primary" icon={Rocket} loading={busy} disabled={!valid}>
          {busy ? z.creating : z.create}
        </Button>
      </form>
    </div>
  );
}
