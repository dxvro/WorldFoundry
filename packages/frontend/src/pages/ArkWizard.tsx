import { Rocket } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { InstallPanel } from '../components/InstallPanel';
import { Button, ErrorNotice, Field, Notice } from '../components/ui';
import { ARK_MAPS } from '../games/ark';
import { GameDisclaimer } from '../games/GameDisclaimer';
import { useI18n } from '../i18n';
import { useLive } from '../live/LiveProvider';
import { serversApi, systemApi } from '../lib/endpoints';
import { serverPath, useRouter } from '../lib/router';
import type { ServerView } from '../lib/types';
import { useQuery } from '../lib/useQuery';

const NAME = /^[^?"\\\r\n]{1,60}$/;

export function ArkWizard(): ReactNode {
  const { t } = useI18n();
  const a = t.ark;
  const { navigate } = useRouter();
  const { state } = useLive();
  const system = useQuery((signal) => systemApi.system(false, signal), []);
  const [name, setName] = useState('');
  const [map, setMap] = useState('TheIsland');
  const [maxPlayers, setMaxPlayers] = useState(70);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [created, setCreated] = useState<ServerView | null>(null);

  useEffect(() => {
    document.title = a.wizardDocumentTitle;
  }, [a]);

  const nameError = name === '' || NAME.test(name.trim()) ? undefined : a.nameInvalid;
  const valid = name.trim() !== '' && nameError === undefined && maxPlayers >= 1 && maxPlayers <= 200;

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      setCreated(await serversApi.createForGame({ game: 'ark', name: name.trim(), map, maxPlayers }));
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
        <h1 className="text-2xl">{a.wizardTitle}</h1>
        <p className="text-dim">{a.wizardIntro}</p>
        <GameDisclaimer game="ark" />
      </div>
      {system.data?.platform === 'linux' ? <Notice tone="info">{a.linuxNote}</Notice> : null}
      <Notice tone="info">{a.memoryNote}</Notice>
      <form className="panel space-y-5 p-4 sm:p-5" onSubmit={(event) => void submit(event)} noValidate>
        <Field label={a.name} hint={a.nameHint} error={nameError}>
          {(props) => <input {...props} className="input" value={name} maxLength={60} onChange={(event) => setName(event.target.value)} />}
        </Field>
        <Field label={a.map}>
          {(props) => (
            <select {...props} className="input" value={map} onChange={(event) => setMap(event.target.value)}>
              {Object.entries(ARK_MAPS).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={a.maxPlayers}>
          {(props) => <input {...props} className="input num w-32" type="number" min={1} max={200} value={maxPlayers} onChange={(event) => setMaxPlayers(Number(event.target.value))} />}
        </Field>
        {error === null ? null : <ErrorNotice error={error} />}
        <Button type="submit" variant="primary" icon={Rocket} loading={busy} disabled={!valid}>
          {busy ? a.creating : a.create}
        </Button>
      </form>
    </div>
  );
}
