import { Eye, EyeOff, Save } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button, ErrorNotice, Notice, Range, Section, Toggle } from '../../components/ui';
import { zomboidSettings } from '../../games/zomboid';
import { useI18n } from '../../i18n';
import { serversApi, systemApi } from '../../lib/endpoints';
import type { RuntimeStatus, ServerView } from '../../lib/types';
import { DeleteServerSection } from './DeleteServerSection';
import { formatMb } from '../../lib/format';
import { useQuery } from '../../lib/useQuery';

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

// The settings of a Project Zomboid server that WorldFoundry manages itself.
export function ZomboidSettingsTab({ server, status }: { server: ServerView; status: RuntimeStatus }): ReactNode {
  const { t } = useI18n();
  const z = t.zomboid.settings;
  const settings = zomboidSettings(server);
  const system = useQuery((signal) => systemApi.system(false, signal), []);
  const [reveal, setReveal] = useState(false);
  const [memory, setMemory] = useState(server.maxRamMb);
  const [autoStart, setAutoStart] = useState(server.autoStart);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const max = Math.max(1024, Math.floor((system.data?.totalMemoryMb ?? 16_384) / 512) * 512);

  const save = async (): Promise<void> => {
    setBusy(true);
    setSaved(false);
    setError(null);
    try {
      await serversApi.update(server.id, { maxRamMb: memory, minRamMb: Math.min(1024, memory), autoStart });
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
      <Section title={z.title}>
        <dl className="space-y-3">
          <Row label={z.profile}>
            <span className="num">{settings.profile}</span>
          </Row>
          <Row label={z.branch}>
            <span className="num">{settings.branch}</span>
          </Row>
          <Row label={z.ports} hint={z.portsHint}>
            <span className="num">
              {server.port}, {settings.udpPort}
            </span>
          </Row>
          <Row label={z.files} hint={z.filesHint}>
            <code className="num break-all">data/Server/{settings.profile}.ini</code>
          </Row>
          <Row label={z.admin} hint={z.adminHint}>
            <span className="inline-flex items-center gap-2">
              <code className="num">{reveal ? settings.adminPassword : '••••••••••••'}</code>
              <Button size="sm" variant="ghost" icon={reveal ? EyeOff : Eye} onClick={() => setReveal((value) => !value)}>
                {reveal ? z.hide : z.show}
              </Button>
            </span>
          </Row>
        </dl>
      </Section>
      <Section title={z.memoryTitle}>
        <div className="space-y-4">
          <Range label={t.zomboid.memory} value={Math.min(memory, max)} min={1024} max={max} step={512} onChange={setMemory} format={formatMb} />
          <Toggle checked={autoStart} onChange={setAutoStart} label={z.autostart} description={z.autostartHint} />
          {error === null ? null : <ErrorNotice error={error} />}
          {saved ? <Notice tone="success">{z.saved}</Notice> : null}
          <Button variant="primary" icon={Save} loading={busy} onClick={() => void save()}>
            {z.save}
          </Button>
        </div>
      </Section>
      <DeleteServerSection server={server} status={status} />
    </div>
  );
}
