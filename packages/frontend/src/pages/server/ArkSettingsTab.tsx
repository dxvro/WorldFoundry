import { Eye, EyeOff, Save } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button, ErrorNotice, Notice, Section, Toggle } from '../../components/ui';
import { ARK_MAPS, arkSettings } from '../../games/ark';
import { useI18n } from '../../i18n';
import { serversApi } from '../../lib/endpoints';
import type { ServerView } from '../../lib/types';

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }): ReactNode {
  return (
    <div className="grid gap-x-4 gap-y-0.5 sm:grid-cols-[12rem_1fr]">
      <dt className="text-sm text-faint">{label}</dt>
      <dd className="min-w-0 text-sm">
        {children}
        {hint === undefined ? null : <p className="hint">{hint}</p>}
      </dd>
    </div>
  );
}

export function ArkSettingsTab({ server }: { server: ServerView }): ReactNode {
  const { t } = useI18n();
  const s = t.ark.settings;
  const settings = arkSettings(server);
  const [reveal, setReveal] = useState(false);
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
          <Row label={s.map}>{ARK_MAPS[settings.map] ?? settings.map}</Row>
          <Row label={s.ports} hint={s.portsHint}>
            <span className="num">{s.portsValue(server.port, settings.peerPort, settings.queryPort, settings.rconPort)}</span>
          </Row>
          <Row label={s.admin} hint={s.adminHint}>
            <span className="inline-flex items-center gap-2">
              <code className="num">{reveal ? settings.adminPassword : '••••••••••••'}</code>
              <Button size="sm" variant="ghost" icon={reveal ? EyeOff : Eye} onClick={() => setReveal((value) => !value)}>
                {reveal ? s.hide : s.show}
              </Button>
            </span>
          </Row>
          <Row label={s.files}>
            <span className="hint">{s.filesHint}</span>
          </Row>
        </dl>
      </Section>
      <Section title={s.startTitle}>
        <div className="space-y-4">
          <Toggle checked={autoStart} onChange={setAutoStart} label={s.autostart} description={s.autostartHint} />
          {error === null ? null : <ErrorNotice error={error} />}
          {saved ? <Notice tone="success">{s.saved}</Notice> : null}
          <Button variant="primary" icon={Save} loading={busy} onClick={() => void save()}>
            {s.save}
          </Button>
        </div>
      </Section>
    </div>
  );
}
