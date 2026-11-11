import { Eye, EyeOff, Plus, Save, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button, ErrorNotice, Field, Notice, Section, Toggle } from '../../components/ui';
import { HostedFieldInput } from '../../games/HostedField';
import { HOSTED_FIELDS, hostedSettings, visible, type FieldValue, type HostedGame } from '../../games/hosted';
import { useI18n } from '../../i18n';
import { serversApi } from '../../lib/endpoints';
import type { RuntimeStatus, ServerView } from '../../lib/types';
import { useLive } from '../../live/LiveProvider';
import { DeleteServerSection } from './DeleteServerSection';

const runningStates: ReadonlySet<string> = new Set(['preparing', 'starting', 'online', 'stopping']);

// Settings of the newer games: the game settings of the create wizard (changeable while stopped), the admin password
// where the game has one, autostart, and deleting the server
export function HostedSettingsTab({ server, status, game }: { server: ServerView; status: RuntimeStatus; game: HostedGame }): ReactNode {
  const { t } = useI18n();
  const { refresh } = useLive();
  const current = hostedSettings(server);
  const fields = HOSTED_FIELDS[game].filter((field) => field.edit);
  const [values, setValues] = useState<Record<string, FieldValue>>(() => Object.fromEntries(fields.map((field) => [field.key, (current[field.key] as FieldValue | undefined) ?? field.default])));
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [autoStart, setAutoStart] = useState(server.autoStart);
  const stopped = !runningStates.has(status.state);
  const admin = typeof current['adminPassword'] === 'string' ? current['adminPassword'] : null;

  const save = async (): Promise<void> => {
    setBusy(true);
    setSaved(false);
    setError(null);
    try {
      const changed = Object.fromEntries(fields.filter((field) => values[field.key] !== current[field.key]).map((field) => [field.key, values[field.key]]));
      if (Object.keys(changed).length > 0) await serversApi.updateGameSettings(server.id, changed);
      if (autoStart !== server.autoStart) await serversApi.update(server.id, { autoStart });
      await refresh();
      setSaved(true);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <Section title={t.hosted.settingsTitle} description={t.hosted.settingsIntro}>
        <div className="space-y-5">
          {stopped ? null : <Notice tone="info">{t.hosted.stopToEdit}</Notice>}
          {fields
            .filter((field) => visible(field, values))
            .map((field) => (
              <HostedFieldInput key={field.key} game={game} field={field} value={values[field.key] ?? field.default} disabled={!stopped} onChange={(value) => setValues((before) => ({ ...before, [field.key]: value }))} />
            ))}
          {admin === null ? null : (
            <div className="space-y-1">
              <p className="label">{t.hosted.adminPassword}</p>
              <span className="inline-flex items-center gap-2">
                <code className="num">{reveal ? admin : '••••••••••••'}</code>
                <Button size="sm" variant="ghost" icon={reveal ? EyeOff : Eye} onClick={() => setReveal((value) => !value)}>
                  {reveal ? t.hosted.hide : t.hosted.show}
                </Button>
              </span>
              <p className="hint">{t.hosted.adminPasswordHint}</p>
            </div>
          )}
          <Toggle checked={autoStart} onChange={setAutoStart} label={t.ark.settings.autostart} description={t.ark.settings.autostartHint} />
          {error === null ? null : <ErrorNotice error={error} />}
          {saved ? <Notice tone="success">{t.hosted.saved}</Notice> : null}
          <Button variant="primary" icon={Save} loading={busy} disabled={!stopped} onClick={() => void save()}>
            {t.hosted.save}
          </Button>
        </div>
      </Section>
      <DeleteServerSection server={server} status={status} />
    </div>
  );
}

// ARK: Survival Ascended: the CurseForge project ids the server downloads itself
export function AsaModsTab({ server, status }: { server: ServerView; status: RuntimeStatus }): ReactNode {
  const { t } = useI18n();
  const m = t.hosted.modIds;
  const { refresh } = useLive();
  const stored = hostedSettings(server)['mods'];
  const [mods, setMods] = useState<string[]>(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : []);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const stopped = !runningStates.has(status.state);
  const valid = /^\d{1,12}$/.test(input.trim());

  const store = async (next: string[]): Promise<void> => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await serversApi.updateGameSettings(server.id, { mods: next });
      setMods(next);
      await refresh();
      setSaved(true);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title={m.title} description={m.intro}>
      <div className="space-y-4">
        {stopped ? null : <Notice tone="info">{t.hosted.stopToEdit}</Notice>}
        {mods.length === 0 ? (
          <p className="text-dim">{m.empty}</p>
        ) : (
          <ul className="divide-y divide-line" aria-label={m.title}>
            {mods.map((id) => (
              <li key={id} className="flex items-center justify-between gap-3 py-2">
                <a className="num" href={`https://www.curseforge.com/ark-survival-ascended/search?search=${id}`} target="_blank" rel="noopener noreferrer">
                  {id}
                </a>
                <Button size="sm" variant="danger" icon={Trash2} aria-label={m.remove(id)} disabled={!stopped || busy} onClick={() => void store(mods.filter((entry) => entry !== id))} />
              </li>
            ))}
          </ul>
        )}
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid && !mods.includes(input.trim())) void store([...mods, input.trim()]).then(() => setInput(''));
          }}
        >
          <Field label={m.label} className="min-w-48 flex-1" {...(input === '' || valid ? {} : { error: m.invalid })}>
            {(props) => <input {...props} className="input num" inputMode="numeric" value={input} disabled={!stopped} onChange={(event) => setInput(event.target.value)} />}
          </Field>
          <Button type="submit" icon={Plus} loading={busy} disabled={!stopped || !valid}>
            {m.add}
          </Button>
        </form>
        {error === null ? null : <ErrorNotice error={error} />}
        {saved ? <Notice tone="success">{t.hosted.saved}</Notice> : null}
      </div>
    </Section>
  );
}
