import { useEffect, type ReactNode } from 'react';
import { AuthProvider, useAuth } from './auth/AuthProvider';
import { AppShell } from './components/AppShell';
import { Button, EmptyState, ErrorNotice, LoadingBlock } from './components/ui';
import { I18nProvider, useI18n } from './i18n';
import { LiveProvider } from './live/LiveProvider';
import { RouterProvider, useRouter } from './lib/router';
import { CreateWizard } from './pages/CreateWizard';
import { ImportWizard } from './pages/ImportWizard';
import { Login } from './pages/Login';
import { Overview } from './pages/Overview';
import { SystemPage } from './pages/System';
import { ServerPage } from './pages/ServerPage';
import { SearchX } from 'lucide-react';

function Routes(): ReactNode {
  const { route, visit, navigate } = useRouter();
  const { t } = useI18n();
  switch (route.name) {
    case 'overview':
      return <Overview />;
    case 'new':
      return <CreateWizard key={visit} />;
    case 'system':
      return <SystemPage />;
    case 'new-world':
      return <ImportWizard key={visit} />;
    case 'server':
      return <ServerPage id={route.id} tab={route.tab} />;
    case 'not-found':
      return (
        <EmptyState icon={SearchX} title={t.shell.notFoundTitle} action={<Button onClick={() => navigate('/')}>{t.shell.toOverview}</Button>}>
          <p>{t.shell.notFoundText}</p>
        </EmptyState>
      );
  }
}

function Gate(): ReactNode {
  const { phase, error, checkSession } = useAuth();
  const { t } = useI18n();

  useEffect(() => {
    if (phase === 'login') document.title = t.login.documentTitle;
  }, [phase, t]);

  if (phase === 'loading') return <LoadingBlock label={t.shell.starting} className="justify-center" />;
  if (phase === 'error') {
    return (
      <div className="mx-auto max-w-md p-6">
        <ErrorNotice error={error} title={t.shell.noConnection} action={<Button size="sm" onClick={() => void checkSession()}>{t.common.retry}</Button>} />
      </div>
    );
  }
  if (phase === 'login') return <Login />;
  return (
    <LiveProvider>
      <AppShell>
        <Routes />
      </AppShell>
    </LiveProvider>
  );
}

export function App(): ReactNode {
  return (
    <I18nProvider>
      <AuthProvider>
        <RouterProvider>
          <Gate />
        </RouterProvider>
      </AuthProvider>
    </I18nProvider>
  );
}
