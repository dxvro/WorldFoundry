import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { setUnauthorizedHandler } from '../lib/api';
import { authApi } from '../lib/endpoints';

export type AuthPhase = 'loading' | 'login' | 'ready' | 'error';

interface AuthContextValue {
  phase: AuthPhase;
  authRequired: boolean;
  // what the login asks for: the access token of the config file, or the password chosen in the UI
  credential: 'none' | 'token' | 'password';
  // the raw cause of a failed session check; show it with <ErrorNotice> so it is translated
  error: unknown;
  // reads the login state from the server; used at start and whenever a socket was refused
  checkSession: () => Promise<void>;
  login: (token: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): ReactNode {
  const [phase, setPhase] = useState<AuthPhase>('loading');
  const [authRequired, setAuthRequired] = useState(false);
  const [credential, setCredential] = useState<AuthContextValue['credential']>('token');
  const [error, setError] = useState<unknown>(null);

  const checkSession = useCallback(async (): Promise<void> => {
    try {
      const status = await authApi.status();
      setAuthRequired(status.authRequired);
      setCredential(status.credential ?? (status.authRequired ? 'token' : 'none'));
      setError(null);
      setPhase(status.authRequired && !status.authenticated ? 'login' : 'ready');
    } catch (cause) {
      setError(cause ?? new Error());
      setPhase((current) => (current === 'ready' ? current : 'error'));
    }
  }, []);

  useEffect(() => {
    // any 401 from the API means the session is gone: back to the login screen
    setUnauthorizedHandler(() => {
      setAuthRequired(true);
      setPhase('login');
    });
    void checkSession();
    return () => setUnauthorizedHandler(null);
  }, [checkSession]);

  const login = useCallback(async (token: string): Promise<void> => {
    const status = await authApi.login(token);
    if (status.credential !== undefined) setCredential(status.credential);
    setError(null);
    setPhase('ready');
  }, []);

  const logout = useCallback(async (): Promise<void> => {
    try {
      await authApi.logout();
    } finally {
      setPhase('login');
    }
  }, []);

  const value = useMemo(() => ({ phase, authRequired, credential, error, checkSession, login, logout }), [phase, authRequired, credential, error, checkSession, login, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (value === null) throw new Error('useAuth muss innerhalb von AuthProvider verwendet werden.');
  return value;
}
