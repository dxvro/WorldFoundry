import { Ban, RefreshCw, ShieldCheck, ShieldOff, UserCheck, UserMinus, UserPlus, Users } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Dialog } from '../../components/Dialog';
import { Button, EmptyState, ErrorNotice, Field, LoadingBlock, Notice, Section, Toggle, cx } from '../../components/ui';
import { renderOptionalRef, useI18n } from '../../i18n';
import { ApiError } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { playersApi } from '../../lib/endpoints';
import type { BanEntry, IpBanEntry, OpEntry, PlayerListKey, PlayersView, RuntimeStatus, ServerView } from '../../lib/types';
import { useQuery } from '../../lib/useQuery';

// same rules as the backend (players/schemas.ts): the Mojang name rule with online mode, printable ASCII without spaces otherwise
export const PLAYER_NAME = /^[A-Za-z0-9_]{1,16}$/;
export const OFFLINE_PLAYER_NAME = /^[\x21-\x7e]{1,32}$/;
// a name with a leading '.' is a Bedrock player (only a running server can add it), so it is not checked against the Mojang rule
export const usesOnlineRule = (name: string, onlineMode: boolean): boolean => onlineMode && !name.startsWith('.');
export function isValidPlayerName(name: string, onlineMode: boolean): boolean {
  if (usesOnlineRule(name, onlineMode)) return PLAYER_NAME.test(name);
  return OFFLINE_PLAYER_NAME.test(name) && !name.startsWith('@');
}
// the input stops at the longest name the rule allows: 16 for Mojang names, 32 otherwise (the same limits as the regexes above)
export const playerNameMaxLength = (name: string, onlineMode: boolean): number => (usesOnlineRule(name, onlineMode) ? 16 : 32);
export const MAX_REASON_LENGTH = 200;
const OP_LEVELS = [1, 2, 3, 4] as const;
type OpLevel = (typeof OP_LEVELS)[number];

const isV4 = (text: string): boolean => /^\d{1,3}(\.\d{1,3}){3}$/.test(text) && text.split('.').every((part) => Number(part) <= 255);

// A light client-side check (the backend does the exact one): dotted IPv4, or IPv6 with optional "::" and an optional IPv4 tail
export function isValidIp(value: string): boolean {
  const text = value.trim();
  if (text === '' || text.length > 45 || text.includes('%')) return false;
  if (!text.includes(':')) return isV4(text);
  if (!/^[0-9a-fA-F:.]+$/.test(text) || text.includes(':::')) return false;
  if ((text.match(/::/g) ?? []).length > 1) return false;
  if ((text.startsWith(':') && !text.startsWith('::')) || (text.endsWith(':') && !text.endsWith('::'))) return false;
  const groups = text.split(':').filter((group) => group !== '');
  let count = groups.length;
  const last = groups[groups.length - 1];
  if (last?.includes('.') === true) {
    if (!isV4(last)) return false;
    groups.pop();
    count += 1;
  }
  if (!groups.every((group) => /^[0-9a-fA-F]{1,4}$/.test(group))) return false;
  return text.includes('::') ? count <= 7 : count === 8;
}

// ban.created / expires look like "2025-03-01 10:00:00 +0100"; anything else (including "forever") returns null
export function parseBanDate(text: string): Date | null {
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-])(\d{2}):?(\d{2})$/.exec(text.trim());
  if (match === null) return null;
  const date = new Date(`${match[1]}T${match[2]}${match[3]}${match[4]}:${match[5]}`);
  return Number.isNaN(date.getTime()) ? null : date;
}

const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const hasName = (list: ReadonlyArray<{ name: string }>, name: string): boolean => list.some((entry) => sameName(entry.name, name));
const clampLevel = (level: number): OpLevel => (OP_LEVELS.find((candidate) => candidate === level) ?? (level < 1 ? 1 : 4));

type Area = PlayerListKey | 'online';
type Run = (area: Area, action: () => Promise<PlayersView>) => Promise<boolean>;

interface ListProps {
  serverId: string;
  view: PlayersView;
  // no changes possible: unsupported, starting/stopping or another change is running
  locked: boolean;
  run: Run;
  error: unknown;
}

function ListRow({ children, actions, testId }: { children: ReactNode; actions: ReactNode; testId: string }): ReactNode {
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3" data-testid={testId}>
      <div className="min-w-0 flex-1 basis-56 space-y-0.5 [overflow-wrap:anywhere]">{children}</div>
      <div className="flex flex-wrap items-center gap-2">{actions}</div>
    </li>
  );
}

const List = ({ children }: { children: ReactNode }): ReactNode => <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line">{children}</ul>;

function CorruptNotice({ list }: { list: PlayerListKey }): ReactNode {
  const { t } = useI18n();
  return (
    <Notice tone="warn" className="mb-3">
      {t.players.corrupt(t.players.files[list])}
    </Notice>
  );
}

interface AddFormProps {
  label: string;
  placeholder: string;
  hint?: ReactNode;
  invalid: string | ((value: string) => string);
  required: string;
  validate: (value: string) => boolean;
  submitLabel: string;
  disabled: boolean;
  // resolves true when the entry was added; the input is cleared then
  onSubmit: (value: string) => Promise<boolean>;
  mono?: boolean;
  // longest entry the input takes, by what is typed so far (player names: 16 or 32, see playerNameMaxLength)
  maxLength?: (value: string) => number;
  children?: ReactNode;
}

// One input plus extra controls and a submit button; the entry is checked on submit and the message disappears while typing
function AddForm({ label, placeholder, hint, invalid, required, validate, submitLabel, disabled, onSubmit, mono = false, maxLength, children }: AddFormProps): ReactNode {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const nameField = (
    <Field label={label} error={error} {...(hint === undefined ? {} : { hint })}>
      {(props) => (
        <input
          {...props}
          className={cx('input', mono && 'num')}
          value={value}
          placeholder={placeholder}
          {...(maxLength === undefined ? {} : { maxLength: maxLength(value) })}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          onChange={(event) => {
            setValue(event.target.value);
            setError(undefined);
          }}
        />
      )}
    </Field>
  );
  const submit = (className?: string): ReactNode => (
    <Button type="submit" variant="primary" icon={UserPlus} loading={sending} disabled={disabled} {...(className === undefined ? {} : { className })}>
      {submitLabel}
    </Button>
  );
  return (
    <form
      noValidate
      className="mt-4 space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        const text = value.trim();
        if (text === '') return setError(required);
        if (!validate(text)) return setError(typeof invalid === 'function' ? invalid(text) : invalid);
        setSending(true);
        void onSubmit(text)
          .then((added) => {
            if (added) setValue('');
          })
          .finally(() => setSending(false));
      }}
    >
      {children === undefined ? (
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
          {nameField}
          {submit('sm:mt-6.5')}
        </div>
      ) : (
        <>
          {nameField}
          {children}
          {submit()}
        </>
      )}
    </form>
  );
}

function ReasonField({ value, onChange, disabled }: { value: string; onChange: (value: string) => void; disabled: boolean }): ReactNode {
  const { t } = useI18n();
  return (
    <Field label={t.players.reason.label}>
      {(props) => <input {...props} className="input" value={value} maxLength={MAX_REASON_LENGTH} disabled={disabled} onChange={(event) => onChange(event.target.value)} />}
    </Field>
  );
}

function WhitelistSection({ serverId, view, locked, run, error }: ListProps): ReactNode {
  const { t } = useI18n();
  const corrupt = view.corrupt.includes('whitelist');
  const disabled = locked || corrupt;
  return (
    <Section title={t.players.whitelist.title} description={t.players.whitelist.description} action={<span className="chip">{t.players.whitelist.count(view.whitelist.length)}</span>}>
      {corrupt ? <CorruptNotice list="whitelist" /> : null}
      {view.whitelist.length === 0 ? (
        <p className="text-dim">{t.players.whitelist.empty}</p>
      ) : (
        <List>
          {view.whitelist.map((entry) => (
            <ListRow
              key={entry.uuid || entry.name}
              testId="whitelist-row"
              actions={
                <Button size="sm" variant="danger" icon={UserMinus} disabled={disabled} aria-label={t.players.whitelist.removeLabel(entry.name)} onClick={() => void run('whitelist', () => playersApi.removeWhitelist(serverId, entry.name))}>
                  {t.players.whitelist.remove}
                </Button>
              }
            >
              <p className="font-medium">{entry.name}</p>
              <p className="hint num break-all">{entry.uuid}</p>
            </ListRow>
          ))}
        </List>
      )}
      <AddForm
        label={t.players.name.label}
        placeholder={t.players.name.placeholder}
        hint={t.players.name.lookupHint}
        invalid={(value) => (usesOnlineRule(value, view.onlineMode) ? t.players.name.invalid : t.players.name.invalidOffline)}
        required={t.players.name.required}
        validate={(value) => isValidPlayerName(value, view.onlineMode)}
        maxLength={(value) => playerNameMaxLength(value, view.onlineMode)}
        submitLabel={t.players.whitelist.add}
        disabled={disabled}
        onSubmit={(name) => run('whitelist', () => playersApi.addWhitelist(serverId, name))}
      />
      {error === null ? null : <ErrorNotice className="mt-3" error={error} title={t.players.actionFailed} />}
    </Section>
  );
}

function OpsSection({ serverId, view, locked, run, error }: ListProps): ReactNode {
  const { t } = useI18n();
  const live = view.mode === 'live';
  const corrupt = view.corrupt.includes('ops');
  const disabled = locked || corrupt;
  const [level, setLevel] = useState<number>(() => clampLevel(view.opPermissionLevel));
  const [bypass, setBypass] = useState(false);
  // while the server runs "/op" only hands out the server's own default level
  const effective = live ? view.opPermissionLevel : level;
  const options: number[] = live && !OP_LEVELS.some((candidate) => candidate === effective) ? [effective, ...OP_LEVELS] : [...OP_LEVELS];
  const help = OP_LEVELS.find((candidate) => candidate === effective);
  // while the server runs, a default of 0 is the only level "/op" can give: the select stays fixed on it and only the name is sent
  const levelFixed = live && view.opPermissionLevel === 0;
  return (
    <Section title={t.players.ops.title} description={t.players.ops.description} action={<span className="chip">{t.players.whitelist.count(view.ops.length)}</span>}>
      {corrupt ? <CorruptNotice list="ops" /> : null}
      {view.ops.length === 0 ? (
        <p className="text-dim">{t.players.ops.empty}</p>
      ) : (
        <List>
          {view.ops.map((entry: OpEntry) => (
            <ListRow
              key={entry.uuid || entry.name}
              testId="op-row"
              actions={
                <Button size="sm" variant="danger" icon={ShieldOff} disabled={disabled} aria-label={t.players.ops.removeLabel(entry.name)} onClick={() => void run('ops', () => playersApi.removeOp(serverId, entry.name))}>
                  {t.players.ops.remove}
                </Button>
              }
            >
              <p className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{entry.name}</span>
                <span className="chip chip-accent">{t.players.ops.levelChip(entry.level)}</span>
                {entry.bypassesPlayerLimit ? <span className="chip">{t.players.ops.bypassChip}</span> : null}
              </p>
              <p className="hint num break-all">{entry.uuid}</p>
            </ListRow>
          ))}
        </List>
      )}
      <AddForm
        label={t.players.name.label}
        placeholder={t.players.name.placeholder}
        hint={t.players.name.lookupHint}
        invalid={(value) => (usesOnlineRule(value, view.onlineMode) ? t.players.name.invalid : t.players.name.invalidOffline)}
        required={t.players.name.required}
        validate={(value) => isValidPlayerName(value, view.onlineMode)}
        maxLength={(value) => playerNameMaxLength(value, view.onlineMode)}
        submitLabel={t.players.ops.add}
        disabled={disabled}
        onSubmit={async (name) => {
          const added = await run('ops', () => playersApi.addOp(serverId, live ? { name } : { name, level, bypassesPlayerLimit: bypass }));
          if (added) setBypass(false);
          return added;
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t.players.ops.levelLabel} hint={help === undefined ? undefined : t.players.ops.levels[help].help}>
            {(props) => (
              <select {...props} className="input" value={effective} disabled={disabled || levelFixed} onChange={(event) => setLevel(Number(event.target.value))}>
                {options.map((option) => {
                  const known = OP_LEVELS.find((candidate) => candidate === option);
                  return (
                    <option key={option} value={option} disabled={live && option !== view.opPermissionLevel}>
                      {known === undefined ? t.players.ops.levelServerDefault(option) : t.players.ops.levelOption(option, t.players.ops.levels[known].short)}
                    </option>
                  );
                })}
              </select>
            )}
          </Field>
          <label className={cx('flex items-start gap-3 sm:mt-6.5', live || disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer')}>
            <input type="checkbox" checked={live ? false : bypass} disabled={live || disabled} onChange={(event) => setBypass(event.target.checked)} className="mt-1 size-5 shrink-0 accent-[var(--color-accent)]" />
            <span>
              {t.players.ops.bypass}
              <span className="hint block">{t.players.ops.bypassHelp}</span>
            </span>
          </label>
        </div>
        <p className="hint">{live ? t.players.ops.liveLocked(view.opPermissionLevel) : t.players.ops.fileOverwrite}</p>
      </AddForm>
      {error === null ? null : <ErrorNotice className="mt-3" error={error} title={t.players.actionFailed} />}
    </Section>
  );
}

function DateText({ value }: { value: string }): ReactNode {
  const date = parseBanDate(value);
  return <>{date === null ? value : formatDateTime(date.getTime())}</>;
}

function BanDetails({ entry }: { entry: BanEntry | IpBanEntry }): ReactNode {
  const { t } = useI18n();
  return (
    <>
      <p className={entry.reason === '' ? 'hint' : undefined}>{entry.reason === '' ? t.players.reason.none : entry.reason}</p>
      <p className="hint">
        {t.players.bans.created} <span className="num"><DateText value={entry.created} /></span> · {t.players.bans.source} {entry.source}
        {entry.expires === 'forever' ? null : (
          <>
            {' · '}
            {t.players.bans.expires} <span className="num"><DateText value={entry.expires} /></span>
          </>
        )}
      </p>
    </>
  );
}

function BansSection({ serverId, view, locked, run, error }: ListProps): ReactNode {
  const { t } = useI18n();
  const corrupt = view.corrupt.includes('bannedPlayers');
  const disabled = locked || corrupt;
  const [reason, setReason] = useState('');
  return (
    <Section title={t.players.bans.title} description={t.players.bans.description} action={<span className="chip">{t.players.whitelist.count(view.bannedPlayers.length)}</span>}>
      {corrupt ? <CorruptNotice list="bannedPlayers" /> : null}
      {view.bannedPlayers.length === 0 ? (
        <p className="text-dim">{t.players.bans.empty}</p>
      ) : (
        <List>
          {view.bannedPlayers.map((entry) => (
            <ListRow
              key={entry.uuid || entry.name}
              testId="ban-row"
              actions={
                <Button size="sm" icon={UserCheck} disabled={disabled} aria-label={t.players.bans.unbanLabel(entry.name)} onClick={() => void run('bannedPlayers', () => playersApi.unban(serverId, entry.name))}>
                  {t.players.bans.unban}
                </Button>
              }
            >
              <p className="font-medium">{entry.name}</p>
              <BanDetails entry={entry} />
            </ListRow>
          ))}
        </List>
      )}
      <AddForm
        label={t.players.name.label}
        placeholder={t.players.name.placeholder}
        hint={t.players.name.lookupHint}
        invalid={(value) => (usesOnlineRule(value, view.onlineMode) ? t.players.name.invalid : t.players.name.invalidOffline)}
        required={t.players.name.required}
        validate={(value) => isValidPlayerName(value, view.onlineMode)}
        maxLength={(value) => playerNameMaxLength(value, view.onlineMode)}
        submitLabel={t.players.bans.add}
        disabled={disabled}
        onSubmit={async (name) => {
          const added = await run('bannedPlayers', () => playersApi.ban(serverId, name, reason.trim()));
          if (added) setReason('');
          return added;
        }}
      >
        <ReasonField value={reason} onChange={setReason} disabled={disabled} />
      </AddForm>
      {error === null ? null : <ErrorNotice className="mt-3" error={error} title={t.players.actionFailed} />}
    </Section>
  );
}

function IpBansSection({ serverId, view, locked, run, error }: ListProps): ReactNode {
  const { t } = useI18n();
  const corrupt = view.corrupt.includes('bannedIps');
  const disabled = locked || corrupt;
  const [reason, setReason] = useState('');
  return (
    <Section title={t.players.ips.title} description={t.players.ips.description} action={<span className="chip">{t.players.whitelist.count(view.bannedIps.length)}</span>}>
      {corrupt ? <CorruptNotice list="bannedIps" /> : null}
      {view.bannedIps.length === 0 ? (
        <p className="text-dim">{t.players.ips.empty}</p>
      ) : (
        <List>
          {view.bannedIps.map((entry) => (
            <ListRow
              key={entry.ip}
              testId="ip-ban-row"
              actions={
                <Button size="sm" icon={UserCheck} disabled={disabled} aria-label={t.players.ips.unbanLabel(entry.ip)} onClick={() => void run('bannedIps', () => playersApi.unbanIp(serverId, entry.ip))}>
                  {t.players.ips.unban}
                </Button>
              }
            >
              <p className="num font-medium">{entry.ip}</p>
              <BanDetails entry={entry} />
            </ListRow>
          ))}
        </List>
      )}
      <AddForm
        mono
        label={t.players.ips.label}
        placeholder={t.players.ips.placeholder}
        invalid={t.players.ips.invalid}
        required={t.players.ips.required}
        validate={isValidIp}
        submitLabel={t.players.ips.add}
        disabled={disabled}
        onSubmit={async (ip) => {
          const added = await run('bannedIps', () => playersApi.banIp(serverId, ip, reason.trim()));
          if (added) setReason('');
          return added;
        }}
      >
        <ReasonField value={reason} onChange={setReason} disabled={disabled} />
      </AddForm>
      {error === null ? null : <ErrorNotice className="mt-3" error={error} title={t.players.actionFailed} />}
    </Section>
  );
}

function OnlineSection({ serverId, view, locked, run, error, status }: ListProps & { status: RuntimeStatus }): ReactNode {
  const { t } = useI18n();
  const [banTarget, setBanTarget] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [banning, setBanning] = useState(false);
  // an error from an earlier quick action must not show up in a freshly opened dialog
  const [attempted, setAttempted] = useState(false);
  const online = status.state === 'online';
  const close = (): void => {
    setBanTarget(null);
    setReason('');
    setAttempted(false);
  };
  const ban = async (): Promise<void> => {
    if (banTarget === null) return;
    setBanning(true);
    setAttempted(true);
    const done = await run('online', () => playersApi.ban(serverId, banTarget, reason.trim()));
    setBanning(false);
    if (done) close();
  };
  return (
    <Section title={t.players.online.title} action={<span className="chip chip-ok">{t.players.online.count(view.online.length)}</span>}>
      {!online ? <p className="text-dim">{t.players.online.offlineHint}</p> : null}
      {online && view.online.length === 0 ? <p className="text-dim">{t.players.online.none}</p> : null}
      {view.online.length === 0 ? null : (
        <List>
          {view.online.map((name) => {
            const whitelisted = hasName(view.whitelist, name);
            const isOp = hasName(view.ops, name);
            return (
              <ListRow
                key={name}
                testId="online-row"
                actions={
                  <>
                    {whitelisted ? (
                      <span className="chip chip-ok">{t.players.online.whitelisted}</span>
                    ) : (
                      <Button size="sm" icon={ShieldCheck} disabled={locked || view.corrupt.includes('whitelist')} aria-label={t.players.online.addWhitelistLabel(name)} onClick={() => void run('online', () => playersApi.addWhitelist(serverId, name))}>
                        {t.players.online.whitelist}
                      </Button>
                    )}
                    {isOp ? (
                      <span className="chip chip-accent">{t.players.online.isOp}</span>
                    ) : (
                      <Button size="sm" icon={UserPlus} disabled={locked || view.corrupt.includes('ops')} aria-label={t.players.online.opLabel(name)} onClick={() => void run('online', () => playersApi.addOp(serverId, { name }))}>
                        {t.players.online.op}
                      </Button>
                    )}
                    <Button size="sm" variant="danger" icon={Ban} disabled={locked || view.corrupt.includes('bannedPlayers')} aria-label={t.players.online.banLabel(name)} onClick={() => setBanTarget(name)}>
                      {t.players.online.ban}
                    </Button>
                  </>
                }
              >
                <p className="font-medium">{name}</p>
              </ListRow>
            );
          })}
        </List>
      )}
      {error === null || banTarget !== null ? null : <ErrorNotice className="mt-3" error={error} title={t.players.actionFailed} />}
      <Dialog
        open={banTarget !== null}
        title={t.players.banDialog.title(banTarget ?? '')}
        onClose={close}
        footer={
          <>
            <Button onClick={close}>{t.common.cancel}</Button>
            <Button variant="danger-solid" icon={Ban} loading={banning} disabled={locked && !banning} onClick={() => void ban()}>
              {t.players.banDialog.confirm}
            </Button>
          </>
        }
      >
        <p className="text-dim">{t.players.banDialog.body}</p>
        <ReasonField value={reason} onChange={setReason} disabled={banning} />
        {error === null || !attempted ? null : <ErrorNotice error={error} title={t.players.actionFailed} />}
      </Dialog>
    </Section>
  );
}

function StatusSection({ server, view, onChanged }: { server: ServerView; view: PlayersView; onChanged: (view: PlayersView) => void }): ReactNode {
  const { t } = useI18n();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const live = view.mode === 'live';
  const toggle = async (enabled: boolean): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      // live mode applies the switch through the console at once; its notice or pending state arrives in the returned view
      onChanged(await playersApi.setWhitelistEnabled(server.id, enabled));
    } catch (cause) {
      setError(cause);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Section title={t.players.status.title}>
      <div className="space-y-4">
        <div className="space-y-1">
          <p className="flex flex-wrap items-center gap-2">
            <span className="label">{t.players.status.modeLabel}</span>
            <span className={cx('chip', live && 'chip-accent')}>{live ? t.players.status.modeLive : t.players.status.modeFile}</span>
          </p>
          <p className="hint">{live ? t.players.status.modeLiveHelp : t.players.status.modeFileHelp}</p>
        </div>
        <Toggle
          checked={view.whitelistEnabled}
          disabled={saving}
          onChange={(value) => void toggle(value)}
          label={t.players.status.whitelistToggle}
          description={
            <>
              {view.whitelistEnabled ? t.players.status.whitelistOn : t.players.status.whitelistOff}
              {live ? ` ${t.players.status.whitelistRestart}` : ''} {t.players.status.whitelistWorld}
            </>
          }
        />
        {error === null ? null : <ErrorNotice error={error} title={t.players.status.whitelistFailed} />}
        {view.onlineMode ? null : <Notice tone="warn">{t.players.status.offlineMode}</Notice>}
        <p className="hint">{t.players.status.opLevelDefault(view.opPermissionLevel)}</p>
      </div>
    </Section>
  );
}

const RETRY_CODES = new Set(['PLAYERS_BUSY', 'PLAYERS_UNSUPPORTED', 'PLAYER_LIST_CORRUPT']);

export function PlayersTab({ server, status }: { server: ServerView; status: RuntimeStatus }): ReactNode {
  const { t } = useI18n();
  const query = useQuery((signal) => playersApi.get(server.id, signal), [server.id]);
  const [working, setWorking] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<Area, unknown>>>({});

  // the lists change with the server: read them again when it starts, stops, or players come and go (the old data stays visible meanwhile)
  const statusKey = `${status.state}|${status.players.join(',')}`;
  const firstKey = useRef(statusKey);
  const { reload, setData } = query;
  useEffect(() => {
    if (firstKey.current === statusKey) return;
    firstKey.current = statusKey;
    reload();
  }, [statusKey, reload]);

  const run: Run = async (area, action) => {
    setWorking(true);
    setErrors((current) => ({ ...current, [area]: null }));
    try {
      setData(await action());
      return true;
    } catch (cause) {
      setErrors((current) => ({ ...current, [area]: cause }));
      if (cause instanceof ApiError && RETRY_CODES.has(cause.code)) reload();
      return false;
    } finally {
      setWorking(false);
    }
  };

  const view = query.data;
  if (query.loading && view === undefined) return <LoadingBlock label={t.players.loading} />;
  if (query.error !== null || view === undefined) {
    return (
      <ErrorNotice
        error={query.error ?? new Error(t.common.unknownError)}
        title={t.players.loadFailed}
        action={<Button size="sm" onClick={reload}>{t.common.retry}</Button>}
      />
    );
  }
  if (!view.supported) return <EmptyState icon={Users} title={t.players.unsupportedTitle}>{t.players.unsupported(server.mcVersion)}</EmptyState>;

  const locked = view.busy || working;
  const common = (list: Area): ListProps => ({ serverId: server.id, view, locked, run, error: errors[list] ?? null });
  return (
    <div className="space-y-4">
      {view.busy ? <Notice tone="info">{t.players.busy}</Notice> : null}
      {view.pending ? (
        <Notice tone="warn" action={<Button size="sm" icon={RefreshCw} onClick={reload}>{t.players.refresh}</Button>}>
          {t.players.pending}
        </Notice>
      ) : view.notice === null ? null : (
        <Notice tone="info">{renderOptionalRef(view.noticeRef, t, view.notice)}</Notice>
      )}
      <StatusSection server={server} view={view} onChanged={setData} />
      <OnlineSection {...common('online')} status={status} />
      <WhitelistSection {...common('whitelist')} />
      <OpsSection {...common('ops')} />
      <BansSection {...common('bannedPlayers')} />
      <IpBansSection {...common('bannedIps')} />
    </div>
  );
}
