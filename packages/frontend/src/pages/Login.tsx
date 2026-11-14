import { KeyRound, Lock } from 'lucide-react';
import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { Disclaimer } from '../components/Disclaimer';
import { BrandMark } from '../components/Brand';
import { ErrorNotice, Button } from '../components/ui';
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
  const fieldId = useId();
  const FieldIcon = usesPassword ? Lock : KeyRound;

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
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 px-4 py-8">
      <div className="flex items-center gap-2.5">
        <BrandMark round className="size-8" />
        <span className="text-lg font-semibold tracking-tight">WorldFoundry</span>
      </div>
      <form onSubmit={(event) => void submit(event)} className="panel w-full max-w-sm space-y-5 rounded-2xl p-5 shadow-xl shadow-black/20 sm:p-7">
        <div className="space-y-2">
          <h1 className="text-xl">{t.login.title}</h1>
          <p className="text-dim">{usesPassword ? t.login.passwordIntro : t.login.tokenIntro}</p>
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center gap-1">
            <label htmlFor={fieldId} className="label">
              {usesPassword ? t.login.passwordLabel : t.login.tokenLabel}
            </label>
            <span className="text-xs text-bad" title={t.login.required} aria-hidden>
              *
            </span>
          </div>
          <div className="relative">
            <FieldIcon aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-faint" />
            <input
              id={fieldId}
              className="input pl-[34px]"
              type="password"
              name="token"
              autoComplete="current-password"
              autoFocus
              aria-required
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
          </div>
        </div>
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
