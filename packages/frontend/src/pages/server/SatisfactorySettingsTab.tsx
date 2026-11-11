import { Save } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button, ErrorNotice, Notice, Section, Toggle } from '../../components/ui';
import { satisfactorySettings } from '../../games/satisfactory';
import { useI18n } from '../../i18n';
import { serversApi } from '../../lib/endpoints';
import type { RuntimeStatus, ServerView } from '../../lib/types';
import { DeleteServerSection } from './DeleteServerSection';

export function SatisfactorySettingsTab({ server, status }: { server: ServerView; status: RuntimeStatus }): ReactNode {
  const { t } = useI18n();
  const s = t.satisfactory.settings;
  const settings = satisfactorySettings(server);
  const [autoStart, setAutoStart] = useState(server.autoStart);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const save = async (): Promise<void> => {
    setBusy(true);
    setSaved(false);
    setError(null);
    try {
      await serversApi.update(server.id, { autoStart });
      setSaved(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error(String(caught)));
    } finally {
      setBusy(false);
    }
  };

  if (settings === null) return <ErrorNotice error={new Error(t.errors.codes.GAME_SETTINGS_INVALID)} />;
  return (
    <div className="space-y-4">
      <Section title={s.title}>
        <dl className="space-y-3">
          <div className="grid gap-x-4 gap-y-0.5 sm:grid-cols-[12rem_1fr]">
            <dt className="text-sm text-faint">{s.branch}</dt>
            <dd className="num text-sm">{settings.branch}</dd>
          </div>
          <div className="grid gap-x-4 gap-y-0.5 sm:grid-cols-[12rem_1fr]">
            <dt className="text-sm text-faint">{s.ports}</dt>
            <dd className="text-sm">
              <span className="num">{t.satisfactory.header.ports(server.port, settings.reliablePort)}</span>
              <p className="hint">{s.portsHint}</p>
            </dd>
          </div>
          <div className="grid gap-x-4 gap-y-0.5 sm:grid-cols-[12rem_1fr]">
            <dt className="text-sm text-faint">{s.claim}</dt>
            <dd className="hint">{s.claimHint}</dd>
          </div>
        </dl>
      </Section>
      <Section title={s.memoryTitle}>
        <div className="space-y-4">
          <Toggle checked={autoStart} onChange={setAutoStart} label={s.autostart} description={s.autostartHint} />
          {error === null ? null : <ErrorNotice error={error} />}
          {saved ? <Notice tone="success">{s.saved}</Notice> : null}
          <Button variant="primary" icon={Save} loading={busy} onClick={() => void save()}>
            {s.save}
          </Button>
        </div>
      </Section>
      <DeleteServerSection server={server} status={status} />
    </div>
  );
}
