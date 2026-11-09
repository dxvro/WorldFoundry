import { Gamepad2, LayoutGrid, LogOut, Plus, Settings, WifiOff } from 'lucide-react';
import type { ReactNode } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { useI18n } from '../i18n';
import { useLive } from '../live/LiveProvider';
import { Link, serverPath, useRouter } from '../lib/router';
import { Disclaimer } from './Disclaimer';
import { StatusLed } from './status';
import { UpdateBanner } from './UpdateBanner';
import { Button, cx } from './ui';

function Brand(): ReactNode {
  return (
    <Link to="/" className="flex min-h-11 items-center gap-2.5 rounded-md text-ink no-underline">
      {/* a world (ring with a meridian) resting on an anvil */}
      <svg aria-hidden viewBox="0 0 32 32" className="size-7 shrink-0">
        <rect width="32" height="32" rx="7" fill="var(--color-raised)" />
        <circle cx="16" cy="12.5" r="6.5" fill="none" stroke="var(--color-accent)" strokeWidth="2" />
        <path d="M9.5 12.5h13M16 6c-3 3.5-3 9.500 0 13M16 6c3 3.5 3 9.500 0 13" fill="none" stroke="var(--color-accent)" strokeWidth="1.4" />
        <path d="M8 22h16l-2.500 4h-11z" fill="var(--color-ok)" />
      </svg>
      <span className="text-base font-semibold tracking-tight">WorldFoundry</span>
    </Link>
  );
}

function navClass(active: boolean): string {
  return cx(
    'flex min-h-10 items-center gap-2.5 rounded-lg px-3 text-dim no-underline hover:bg-raised hover:text-ink',
    active && 'bg-raised text-ink',
  );
}

function LogoutButton({ className }: { className?: string }): ReactNode {
  const { authRequired, logout } = useAuth();
  const { t } = useI18n();
  if (!authRequired) return null;
  return (
    <Button variant="ghost" size="sm" icon={LogOut} className={className} onClick={() => void logout()}>
      {t.shell.logout}
    </Button>
  );
}

function ConnectionBanner(): ReactNode {
  const { state } = useLive();
  const { t } = useI18n();
  if (state.connection === 'open') return null;
  return (
    <div role="alert" className="flex items-center gap-2 border-b border-warn/40 bg-warn/10 px-4 py-2 text-warn">
      <WifiOff aria-hidden className="size-4 shrink-0" />
      <p className="text-sm">
        {state.connection === 'connecting' ? t.shell.connecting : t.shell.connectionLost}
      </p>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }): ReactNode {
  const { route } = useRouter();
  const { state, statusFor } = useLive();
  const { t } = useI18n();
  const servers = state.servers ?? [];
  const isNew = route.name === 'new' || route.name === 'new-game' || route.name === 'new-world';

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[17rem_1fr]">
      <aside className="hidden border-r border-line bg-panel lg:flex lg:h-dvh lg:flex-col lg:sticky lg:top-0">
        <div className="p-4">
          <Brand />
        </div>
        <nav aria-label={t.shell.mainNavigation} className="flex flex-col gap-1 px-3">
          <Link to="/" className={navClass(route.name === 'overview')} aria-current={route.name === 'overview' ? 'page' : undefined}>
            <LayoutGrid aria-hidden className="size-4" />
            {t.shell.overview}
          </Link>
          <Link to="/new" className={navClass(isNew)} aria-current={isNew ? 'page' : undefined}>
            <Plus aria-hidden className="size-4" />
            {t.shell.newServer}
          </Link>
          <Link to="/games" className={navClass(route.name === 'games')} aria-current={route.name === 'games' ? 'page' : undefined}>
            <Gamepad2 aria-hidden className="size-4" />
            {t.games.nav}
          </Link>
          <Link to="/system" className={navClass(route.name === 'system')} aria-current={route.name === 'system' ? 'page' : undefined}>
            <Settings aria-hidden className="size-4" />
            {t.shell.system}
          </Link>
        </nav>
        <div className="mt-4 min-h-0 flex-1 overflow-y-auto px-3 pb-3">
          <h2 className="px-3 pb-1 text-xs font-medium uppercase tracking-wide text-faint">{t.shell.servers}</h2>
          {servers.length === 0 ? (
            <p className="px-3 py-1 hint">{state.servers === null ? t.shell.loadingServers : t.shell.noServers}</p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {servers.map((server) => {
                const active = route.name === 'server' && route.id === server.id;
                return (
                  <li key={server.id}>
                    <Link to={serverPath(server.id)} className={navClass(active)} aria-current={active ? 'page' : undefined}>
                      <StatusLed server={server} status={statusFor(server)} />
                      <span className="truncate">{server.name}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="space-y-2 border-t border-line p-3">
          <LogoutButton className="w-full justify-start" />
          <Disclaimer className="px-1" />
        </div>
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-line bg-panel/95 px-4 py-2.5 backdrop-blur-sm lg:hidden">
          <Brand />
          <div className="flex items-center gap-2">
            <LogoutButton />
          </div>
        </header>
        <ConnectionBanner />
        <UpdateBanner />
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-5 sm:px-6 lg:pb-8">{children}</main>
        {/* below the content on phones and tablets (the sidebar carries it on desktop); the padding keeps it clear of the fixed bottom navigation */}
        <footer className="border-t border-line px-4 pb-20 pt-3 sm:px-6 lg:hidden">
          <Disclaimer />
        </footer>
        <nav aria-label={t.shell.mainNavigation} className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-4 border-t border-line bg-panel lg:hidden">
          <Link to="/" className={cx(navClass(route.name === 'overview' || route.name === 'server'), 'min-h-14 justify-center rounded-none px-1! text-sm')} aria-current={route.name === 'overview' ? 'page' : undefined}>
            <LayoutGrid aria-hidden className="size-5" />
            {t.shell.overview}
          </Link>
          <Link to="/new" className={cx(navClass(isNew), 'min-h-14 justify-center rounded-none px-1! text-sm')} aria-current={isNew ? 'page' : undefined}>
            <Plus aria-hidden className="size-5" />
            {t.shell.newServer}
          </Link>
          <Link to="/games" className={cx(navClass(route.name === 'games'), 'min-h-14 justify-center rounded-none px-1! text-sm')} aria-current={route.name === 'games' ? 'page' : undefined}>
            <Gamepad2 aria-hidden className="size-5" />
            {t.games.nav}
          </Link>
          <Link to="/system" className={cx(navClass(route.name === 'system'), 'min-h-14 justify-center rounded-none px-1! text-sm')} aria-current={route.name === 'system' ? 'page' : undefined}>
            <Settings aria-hidden className="size-5" />
            {t.shell.system}
          </Link>
        </nav>
      </div>
    </div>
  );
}
