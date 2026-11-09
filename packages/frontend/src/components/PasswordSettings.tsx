import { KeyRound } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { useI18n } from '../i18n';
import { authApi } from '../lib/endpoints';
import { PASSWORD_MIN_LENGTH, passwordStrength } from '../lib/password';
import { Button, ErrorNotice, Field, Notice, Section, cx } from './ui';

function StrengthMeter({ password }: { password: string }): ReactNode {
  useI18n();
  if (password === '') return null;
  const { level, label, hint } = passwordStrength(password);
  const color = level === 3 ? 'bg-ok' : level === 2 ? 'bg-warn' : 'bg-bad';
  return (
    <div className="space-y-1" aria-live="polite">
      <div className="flex gap-1" aria-hidden>
        {[1, 2, 3].map((segment) => (
          <span key={segment} className={cx('h-1.5 flex-1 rounded-full', segment <= level ? color : 'bg-raised')} />
        ))}
      </div>
      <p className="hint">
        <strong className="font-medium text-ink">{label}.</strong> {hint}
      </p>
    </div>
  );
}

export function PasswordSection(): ReactNode {
  const { t } = useI18n();
  const { authRequired, credential, checkSession } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);

  const mismatch = repeat !== '' && repeat !== next;
  const tooShort = next !== '' && next.length < PASSWORD_MIN_LENGTH;
  const canSubmit = next.length >= PASSWORD_MIN_LENGTH && repeat === next && (!authRequired || current !== '');

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!canSubmit || busy) return;
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      await authApi.changePassword(authRequired ? { currentPassword: current, newPassword: next } : { newPassword: next });
      setCurrent('');
      setNext('');
      setRepeat('');
      setDone(true);
      await checkSession();
    } catch (cause) {
      setError(cause);
      setCurrent('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title={t.password.title} description={authRequired ? t.password.describeChange : t.password.describeSet}>
      <div className="space-y-4">
        {!authRequired ? (
          <Notice tone="warn" title={t.password.noPasswordTitle}>
            <p>{t.password.noPasswordText}</p>
          </Notice>
        ) : (
          <p className="text-dim">
            {credential === 'password' ? t.password.signedInWithPassword : t.password.signedInWithToken} {t.password.otherSessionsEnd}
          </p>
        )}
        <form className="space-y-4" onSubmit={(event) => void submit(event)}>
          {authRequired ? (
            <Field label={t.password.current} hint={credential === 'password' ? undefined : t.password.currentHint}>
              {(props) => <input {...props} className="input" type="password" name="current-password" autoComplete="current-password" value={current} onChange={(event) => setCurrent(event.target.value)} />}
            </Field>
          ) : null}
          <Field label={t.password.next} error={tooShort ? t.password.minLength(PASSWORD_MIN_LENGTH) : undefined}>
            {(props) => <input {...props} className="input" type="password" name="new-password" autoComplete="new-password" value={next} onChange={(event) => setNext(event.target.value)} />}
          </Field>
          <StrengthMeter password={next} />
          <Field label={t.password.repeat} error={mismatch ? t.password.mismatch : undefined}>
            {(props) => <input {...props} className="input" type="password" name="repeat-password" autoComplete="new-password" value={repeat} onChange={(event) => setRepeat(event.target.value)} />}
          </Field>
          {error === null ? null : <ErrorNotice error={error} />}
          {done ? (
            <Notice tone="success" title={authRequired ? t.password.changedTitle : t.password.setTitle}>
              <p>{t.password.doneText}</p>
            </Notice>
          ) : null}
          <Button type="submit" variant="primary" icon={KeyRound} loading={busy} disabled={!canSubmit}>
            {authRequired ? t.password.change : t.password.set}
          </Button>
        </form>
        <p className="hint">
          {t.password.tokenNoteStart}
          <code>Authorization: Bearer …</code>
          {t.password.tokenNoteEnd}
        </p>
      </div>
    </Section>
  );
}
