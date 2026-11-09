import { KeyRound } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { Disclaimer } from '../components/Disclaimer';
import { ErrorNotice, Button, Field } from '../components/ui';
import { ApiError } from '../lib/api';
import { useI18n } from '../i18n';

export function Login(): ReactNode {
  const { login, credential } = useAuth();
  const { t } = useI18n();
  const usesPassword = credential === 'password';
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [retryIn, setRetryIn] = useState(0);

  useEffect(() => {
    if (retryIn <= 0) return;
    const timer = setTimeout(() => setRetryIn((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [retryIn]);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (token === '' || busy || retryIn > 0) return;
    setBusy(true);
    setError(null);
    try {
      await login(token);
    } catch (cause) {
      setError(cause);
      setToken('');
      if (cause instanceof ApiError && cause.code === 'TOO_MANY_ATTEMPTS') {
        const details = cause.details as { retryAfterSeconds?: unknown } | undefined;
        if (typeof details?.retryAfterSeconds === 'number') setRetryIn(details.retryAfterSeconds);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-5 px-4 py-8">
      <form onSubmit={(event) => void submit(event)} className="panel w-full max-w-sm space-y-5 p-6">
        <div className="space-y-2">
          <span className="grid size-10 place-items-center rounded-lg bg-raised text-accent">
            <KeyRound aria-hidden className="size-5" />
          </span>
          <h1 className="text-xl">{t.login.title}</h1>
          {usesPassword ? (
            <p className="text-dim">{t.login.passwordIntro}</p>
          ) : (
            <p className="text-dim">{t.login.tokenIntro}</p>
          )}
        </div>
        <Field label={usesPassword ? t.login.passwordLabel : t.login.tokenLabel}>
          {(props) => (
            <input
              {...props}
              className="input"
              type="password"
              name="token"
              autoComplete="current-password"
              autoFocus
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
          )}
        </Field>
        {error === null ? null : <ErrorNotice error={error} />}
        {retryIn > 0 ? <p className="hint">{t.login.retryIn(retryIn)}</p> : null}
        <Button type="submit" variant="primary" className="w-full" loading={busy} disabled={token === '' || retryIn > 0}>
          {t.login.submit}
        </Button>
      </form>
      <Disclaimer className="max-w-sm text-center" />
    </div>
  );
}
