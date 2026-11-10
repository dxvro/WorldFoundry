import { useState, type FormEvent, type ReactNode } from 'react';
import { Dialog } from '../../components/Dialog';
import { Button, ErrorNotice, Field, LoadingBlock, Notice, Section } from '../../components/ui';
import { useI18n } from '../../i18n';
import { gamePlayersApi } from '../../lib/endpoints';
import type { RuntimeStatus, ServerView } from '../../lib/types';
import { useQuery } from '../../lib/useQuery';

const NAME = /^[^"\\\r\n]{1,64}$/;

// Players of a game other than Minecraft: who is online and the admin commands of that game.
export function GamePlayersTab({ server, status }: { server: ServerView; status: RuntimeStatus }): ReactNode {
  const { t } = useI18n();
  const p = t.gamePlayers;
  const view = useQuery((signal) => gamePlayersApi.get(server.id, signal), [server.id, status.state, status.players.join(','), status.playerCount ?? null]);
  const [name, setName] = useState('');
  const [pending, setPending] = useState<{ action: { id: string; label: string }; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const online = status.state === 'online';

  const send = async (action: { id: string; label: string }, target: string): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setNotice(p.sent((await gamePlayersApi.act(server.id, action.id, target)).sent));
      setPending(null);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };
  const ask = (action: { id: string; label: string; confirm: boolean }, target: string): void => {
    if (action.confirm) setPending({ action, name: target });
    else void send(action, target);
  };

  if (view.error !== null) return <ErrorNotice error={view.error} action={<Button size="sm" onClick={view.reload}>{t.common.retry}</Button>} />;
  if (view.data === undefined) return <LoadingBlock />;
  const data = view.data;

  const submit = (event: FormEvent): void => event.preventDefault();

  return (
    <div className="space-y-4">
      {online ? null : <Notice tone="info">{p.offline}</Notice>}
      {error === null ? null : <ErrorNotice error={error} />}
      {notice === null ? null : <Notice tone="success">{notice}</Notice>}
      <Section title={p.online} description={data.online.length === 0 && data.count !== null ? p.countOnly(data.count) : undefined}>
        {data.online.length === 0 ? (
          <p className="hint">{online && data.count === null && data.actions.length === 0 ? p.countUnknown : p.nobody}</p>
        ) : (
          <ul className="space-y-2" aria-label={p.online}>
            {data.online.map((player) => (
              <li key={player} className="flex flex-wrap items-center gap-2 rounded-lg border border-line p-3">
                <span className="flex-1 font-medium">{player}</span>
                {data.actions.map((action) => (
                  <Button key={action.id} size="sm" variant={action.confirm ? 'danger' : 'secondary'} aria-label={p.actionLabel(action.label, player)} disabled={!online || busy} onClick={() => ask(action, player)}>
                    {action.label}
                  </Button>
                ))}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title={p.byName} description={p.byNameHint}>
        {data.actions.length === 0 ? (
          <p className="hint">{p.noActions}</p>
        ) : (
          <form className="space-y-3" onSubmit={submit}>
            <Field label={p.nameLabel}>{(props) => <input {...props} className="input" value={name} maxLength={64} onChange={(event) => setName(event.target.value)} />}</Field>
            <div className="flex flex-wrap gap-2">
              {data.actions.map((action) => (
                <Button key={action.id} size="sm" variant={action.confirm ? 'danger' : 'secondary'} disabled={!online || busy || !NAME.test(name.trim())} onClick={() => ask(action, name.trim())}>
                  {action.label}
                </Button>
              ))}
            </div>
          </form>
        )}
      </Section>
      <Dialog
        open={pending !== null}
        title={pending === null ? '' : p.confirmTitle(pending.action.label, pending.name)}
        onClose={() => setPending(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPending(null)}>
              {t.common.cancel}
            </Button>
            <Button variant="danger" loading={busy} onClick={() => pending !== null && void send(pending.action, pending.name)}>
              {pending?.action.label ?? ''}
            </Button>
          </>
        }
      >
        <p>{p.confirmBody}</p>
      </Dialog>
    </div>
  );
}
