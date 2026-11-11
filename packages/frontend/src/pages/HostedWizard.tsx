import { Rocket } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { InstallPanel } from '../components/InstallPanel';
import { Button, ErrorNotice, Field, Notice } from '../components/ui';
import { GameDisclaimer } from '../games/GameDisclaimer';
import { HostedFieldInput } from '../games/HostedField';
import { HOSTED_FIELDS, visible, type FieldValue, type HostedGame } from '../games/hosted';
import { useI18n } from '../i18n';
import { useLive } from '../live/LiveProvider';
import { serversApi, systemApi } from '../lib/endpoints';
import { serverPath, useRouter } from '../lib/router';
import type { ServerView } from '../lib/types';
import { useQuery } from '../lib/useQuery';

// The create wizard of ARK: Survival Ascended, Valheim, 7 Days to Die, Palworld and Terraria
export function HostedWizard({ game }: { game: HostedGame }): ReactNode {
  const { t } = useI18n();
  const h = t.hosted[game];
  const { navigate } = useRouter();
  const { state } = useLive();
  const system = useQuery((signal) => systemApi.system(false, signal), []);
  const fields = HOSTED_FIELDS[game].filter((field) => field.create);
  const [name, setName] = useState('');
  const [values, setValues] = useState<Record<string, FieldValue>>(() => Object.fromEntries(fields.map((field) => [field.key, field.default])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [created, setCreated] = useState<ServerView | null>(null);

  useEffect(() => {
    document.title = h.documentTitle;
  }, [h]);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (name.trim() === '') return;
    setBusy(true);
    setError(null);
    // empty optional texts (a password left empty) are sent as they are; fields that are hidden are left out
    const body = Object.fromEntries(fields.filter((field) => visible(field, values)).map((field) => [field.key, values[field.key]]));
    if (game === 'valheim' && values['password'] === '') delete body['password'];
    try {
      setCreated(await serversApi.createForGame({ game, name: name.trim(), ...body }));
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
        <h1 className="text-2xl">{h.title}</h1>
        <p className="text-dim">{h.intro}</p>
        <GameDisclaimer game={game} />
      </div>
      {game === 'asa' && system.data?.platform === 'linux' ? <Notice tone="info">{t.hosted.asa.linuxNote}</Notice> : null}
      <form className="panel space-y-5 p-4 sm:p-5" onSubmit={(event) => void submit(event)} noValidate>
        <Field label={(h.fields as Record<string, { label: string; hint: string }>)['name']?.label ?? 'Name'} hint={(h.fields as Record<string, { label: string; hint: string }>)['name']?.hint}>
          {(props) => <input {...props} className="input" value={name} maxLength={60} onChange={(event) => setName(event.target.value)} />}
        </Field>
        {fields
          .filter((field) => visible(field, values))
          .map((field) => (
            <HostedFieldInput key={field.key} game={game} field={field} value={values[field.key] ?? field.default} onChange={(value) => setValues((current) => ({ ...current, [field.key]: value }))} />
          ))}
        {error === null ? null : <ErrorNotice error={error} />}
        <Button type="submit" variant="primary" icon={Rocket} loading={busy} disabled={name.trim() === ''}>
          {busy ? t.hosted.creating : t.hosted.create}
        </Button>
      </form>
    </div>
  );
}
