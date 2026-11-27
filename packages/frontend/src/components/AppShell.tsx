import { Activity, Bell, BookOpen, ChevronDown, Gamepad2, LayoutGrid, LifeBuoy, LogOut, Menu, Moon, Plus, Search, Server, Settings, Sun, Trash2, User, WifiOff, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { useGames } from '../games/GamesProvider';
import { GameTile } from '../games/GameTile';
import { GAME_LOOK, GAME_ORDER } from '../games/look';
import { useI18n } from '../i18n';
import { systemApi } from '../lib/endpoints';
import { formatBytes } from '../lib/format';
import { Link, SCROLL_ID, serverPath, useRouter } from '../lib/router';
import { readFlag, writeFlag } from '../lib/storage';
import { useTheme } from '../lib/theme';
import type { DiskInfo } from '../lib/types';
import { bannerKind } from '../lib/update';
import { useLive } from '../live/LiveProvider';
import { BrandMark } from './Brand';
import { Dialog } from './Dialog';
import { Disclaimer } from './Disclaimer';
import { StatusLed } from './status';
import { UpdateBanner } from './UpdateBanner';
import { Button, ProgressBar, cx } from './ui';

const REPO_URL = 'https://github.com/dxvro/WorldFoundry';
const SIDEBAR_ID = 'app-sidebar';
const KEY_COLLAPSED = 'worldfoundry.sidebar.collapsed';
const KEY_SERVERS_OPEN = 'worldfoundry.sidebar.servers';
const DISK_REFRESH_MS = 60_000;

// Wide screens keep the sidebar beside the content; below that it slides in over it.
function useIsDesktop(): boolean {
  const query = '(min-width: 1024px)';
  const supported = typeof window.matchMedia === 'function';
  const [matches, setMatches] = useState(() => (supported ? window.matchMedia(query).matches : true));
  useEffect(() => {
    if (!supported) return;
    const list = window.matchMedia(query);
    const onChange = (): void => setMatches(list.matches);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [supported]);
  return matches;
}

// Closes a popover on Escape and on a press outside of it
function useDismiss(open: boolean, root: RefObject<HTMLElement | null>, close: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent): void => {
      if (root.current !== null && !root.current.contains(event.target as Node)) close();
    };
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, root, close]);
}

function Brand(): ReactNode {
  return (
    <Link to="/" className="flex min-h-9 items-center gap-2.5 rounded-md text-ink no-underline">
      <BrandMark />
      <span className="text-base font-semibold tracking-tight">WorldFoundry</span>
    </Link>
  );
}

interface Attention {
  key: string;
  text: string;
  to: string;
  tone: 'bad' | 'accent';
}

// What the bell lists: servers that crashed or failed to install, and a new version of WorldFoundry
function useAttention(): { items: Attention[]; servers: number } {
  const { state, statusFor } = useLive();
  const { t } = useI18n();
  return useMemo(() => {
    const items: Attention[] = [];
    for (const server of state.servers ?? []) {
      if (server.installState === 'failed') items.push({ key: `install-${server.id}`, text: t.shell.noticeInstallFailed(server.name), to: serverPath(server.id), tone: 'bad' });
      else if (statusFor(server).state === 'crashed') items.push({ key: `crash-${server.id}`, text: t.shell.noticeCrashed(server.name), to: serverPath(server.id), tone: 'bad' });
    }
    const servers = items.length;
    const latest = state.update?.latest;
    if (bannerKind(state.update) === 'available' && latest !== null && latest !== undefined) {
      items.push({ key: 'update', text: t.shell.noticeUpdate(latest.version), to: '/system', tone: 'accent' });
    }
    return { items, servers };
  }, [state.servers, state.update, statusFor, t]);
}

interface SearchEntry {
  key: string;
  label: string;
  detail: string;
  to: string;
}

// Finds servers and pages by name. On narrow screens it covers the navbar while `open`.
function ShellSearch({ open, onClose }: { open: boolean; onClose: () => void }): ReactNode {
  const { t } = useI18n();
  const { state } = useLive();
  const { nameOf } = useGames();
  const { navigate } = useRouter();
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement | null>(null);
  const listId = useId();

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  const entries = useMemo<SearchEntry[]>(() => {
    const pages: SearchEntry[] = [
      { key: 'overview', label: t.shell.overview, detail: '', to: '/' },
      { key: 'new', label: t.shell.newServer, detail: '', to: '/new' },
      { key: 'games', label: t.games.nav, detail: '', to: '/games' },
      { key: 'usage', label: t.usage.nav, detail: '', to: '/usage' },
      { key: 'system', label: t.shell.system, detail: '', to: '/system' },
    ];
    const servers = (state.servers ?? []).map((server) => ({ key: server.id, label: server.name, detail: nameOf(server.game), to: serverPath(server.id) }));
    return [...servers, ...pages];
  }, [state.servers, nameOf, t]);

  const needle = query.trim().toLowerCase();
  const results = needle === '' ? [] : entries.filter((entry) => `${entry.label} ${entry.detail}`.toLowerCase().includes(needle)).slice(0, 8);
  const showResults = focused && needle !== '';
  const current = Math.min(active, Math.max(0, results.length - 1));

  const go = (entry: SearchEntry): void => {
    setQuery('');
    setActive(0);
    onClose();
    input.current?.blur();
    navigate(entry.to);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' && results.length > 0) {
      event.preventDefault();
      setActive((current + 1) % results.length);
    } else if (event.key === 'ArrowUp' && results.length > 0) {
      event.preventDefault();
      setActive((current - 1 + results.length) % results.length);
    } else if (event.key === 'Enter') {
      const entry = results[current];
      if (entry !== undefined) {
        event.preventDefault();
        go(entry);
      }
    } else if (event.key === 'Escape') {
      if (query !== '') setQuery('');
      else onClose();
    }
  };

  return (
    <div className={cx(open ? 'absolute inset-0 z-10 flex bg-panel px-3' : 'hidden', 'items-center gap-2 md:static md:z-auto md:flex md:w-full md:max-w-sm md:bg-transparent md:px-0')}>
      <div className="relative min-w-0 flex-1">
        <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-faint" />
        <input
          ref={input}
          type="search"
          role="combobox"
          aria-label={t.shell.search}
          aria-expanded={showResults}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showResults && results[current] !== undefined ? `${listId}-${current}` : undefined}
          placeholder={t.shell.searchPlaceholder}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={onKeyDown}
          className="w-full rounded-lg border border-line bg-raised py-2 pr-2.5 pl-[34px] placeholder:text-faint hover:border-line-strong"
        />
        {showResults ? (
          <ul id={listId} role="listbox" aria-label={t.shell.searchResults} className="absolute inset-x-0 top-full z-40 mt-1 max-h-80 overflow-y-auto rounded-xl border border-line bg-raised p-2 shadow-lg">
            {results.length === 0 ? (
              <li className="p-2 text-sm text-faint">{t.shell.searchNoResults}</li>
            ) : (
              results.map((entry, index) => (
                <li
                  key={entry.key}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === current}
                  // keeps the focus in the field, so the list is still there when the click arrives
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => go(entry)}
                  className={cx('flex cursor-pointer items-baseline justify-between gap-3 rounded-lg p-2 text-sm', index === current ? 'bg-hover text-ink' : 'text-dim')}
                >
                  <span className="truncate font-medium">{entry.label}</span>
                  {entry.detail === '' ? null : <span className="shrink-0 text-xs text-faint">{entry.detail}</span>}
                </li>
              ))
            )}
          </ul>
        ) : null}
      </div>
      <button type="button" className="icon-btn md:hidden" aria-label={t.shell.closeSearch} onClick={onClose}>
        <X aria-hidden className="size-4" />
      </button>
    </div>
  );
}

function NotificationBell({ items }: { items: Attention[] }): ReactNode {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  const panelId = useId();
  useDismiss(open, root, () => setOpen(false));
  return (
    <div ref={root} className="relative hidden sm:block">
      <button
        type="button"
        className="icon-btn relative"
        aria-label={items.length === 0 ? t.shell.notifications : t.shell.notificationsWith(items.length)}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <Bell aria-hidden className="size-4" />
        {items.length === 0 ? null : (
          <span aria-hidden className="num absolute right-0.5 top-0.5 grid size-4 place-items-center rounded-full bg-bad-strong text-[10px] font-semibold leading-none text-white">
            {items.length > 9 ? '9+' : items.length}
          </span>
        )}
      </button>
      {open ? (
        <div id={panelId} className="absolute right-0 top-full z-40 mt-1 w-72 rounded-xl border border-line bg-raised p-2 shadow-lg">
          {items.length === 0 ? (
            <p className="p-2 text-sm text-faint">{t.shell.nothingNeedsAttention}</p>
          ) : (
            <ul className="flex flex-col">
              {items.map((item) => (
                <li key={item.key}>
                  <Link to={item.to} onClick={() => setOpen(false)} className="flex items-start gap-2 rounded-lg p-2 text-sm font-medium text-dim no-underline hover:bg-hover hover:text-ink">
                    <span aria-hidden className={cx('led mt-1.5', item.tone === 'bad' ? 'text-bad' : 'text-accent')} />
                    <span className="min-w-0">{item.text}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

function ConnectionBanner(): ReactNode {
  const { state } = useLive();
  const { t } = useI18n();
  if (state.connection === 'open') return null;
  return (
    <div role="alert" className="flex items-center gap-2 border-b border-warn/40 bg-warn/10 px-4 py-2 text-warn">
      <WifiOff aria-hidden className="size-4 shrink-0" />
      <p className="text-sm">{state.connection === 'connecting' ? t.shell.connecting : t.shell.connectionLost}</p>
    </div>
  );
}

function navClass(active: boolean): string {
  return cx('flex min-h-9 w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left font-medium no-underline hover:bg-hover hover:text-ink', active ? 'bg-raised text-accent' : 'text-dim');
}

// The volume of the data folder: read when the shell appears and once a minute after that
function useDisk(): DiskInfo | null {
  const [disk, setDisk] = useState<DiskInfo | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        const info = await systemApi.disk();
        if (alive && typeof info?.totalBytes === 'number' && typeof info.freeBytes === 'number' && info.totalBytes > 0) setDisk(info);
      } catch {
        // the block is optional: without an answer it is not shown
      }
    };
    void load();
    const timer = setInterval(() => void load(), DISK_REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  return disk;
}

function StorageBlock(): ReactNode {
  const { t } = useI18n();
  const { state } = useLive();
  const { nameOf } = useGames();
  const disk = useDisk();
  const [open, setOpen] = useState(false);
  if (disk === null || disk.totalBytes === null || disk.freeBytes === null) return null;
  const used = Math.min(100, Math.max(0, ((disk.totalBytes - disk.freeBytes) / disk.totalBytes) * 100));
  const rows = (Array.isArray(disk.backups) ? disk.backups : []).flatMap((entry) => {
    const server = (state.servers ?? []).find((candidate) => candidate.id === entry.serverId);
    return server === undefined || entry.bytes <= 0 ? [] : [{ ...entry, server }];
  });
  return (
    <div className="flex flex-col gap-2 border-t border-line p-3">
      <div>
        <p className="text-xs text-faint">{t.shell.spaceLeft}</p>
        <p className="num text-base font-semibold">{t.shell.spaceOf(formatBytes(disk.freeBytes), formatBytes(disk.totalBytes))}</p>
      </div>
      <ProgressBar percent={used} label={t.shell.diskUsed} />
      <Button size="sm" icon={Trash2} className="mt-1 w-full bg-transparent" onClick={() => setOpen(true)}>
        {t.shell.freeUpSpace}
      </Button>
      <Dialog open={open} title={t.shell.freeUpSpace} onClose={() => setOpen(false)}>
        <p className="text-dim">{t.shell.freeUpIntro}</p>
        {rows.length === 0 ? (
          <p className="hint">{t.shell.freeUpNone}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {rows.map(({ server, bytes, count }) => (
              <li key={server.id}>
                <Link to={serverPath(server.id, 'backups')} onClick={() => setOpen(false)} className="flex items-center gap-3 rounded-lg p-2 text-ink no-underline hover:bg-hover">
                  <GameTile game={server.game} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{server.name}</span>
                    <span className="block truncate text-xs text-faint">
                      {nameOf(server.game)} · {t.shell.freeUpBackups(count)}
                    </span>
                  </span>
                  <span className="num shrink-0 font-medium">{formatBytes(bytes)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        <p className="hint">
          {t.shell.freeUpJava}{' '}
          <Link to="/system" onClick={() => setOpen(false)}>
            {t.shell.system}
          </Link>
        </p>
      </Dialog>
    </div>
  );
}

function ServerList(): ReactNode {
  const { route } = useRouter();
  const { state, statusFor } = useLive();
  const { nameOf } = useGames();
  const { t } = useI18n();
  const servers = state.servers ?? [];
  if (servers.length === 0) return <p className="px-2.5 py-1 hint">{state.servers === null ? t.shell.loadingServers : t.shell.noServers}</p>;
  // one group per game, in the order of the games page, so that equal names are told apart
  return (
    <div className="flex flex-col gap-2">
      {GAME_ORDER.filter((game) => servers.some((server) => server.game === game)).map((game) => (
        <div key={game} role="group" aria-label={t.games.groupLabel(nameOf(game))}>
          <h3 className="flex items-center gap-2 px-2.5 py-1 text-xs font-medium text-faint">
            <GameTile game={game} size="sm" />
            <span className="truncate">{GAME_LOOK[game].shortName}</span>
          </h3>
          <ul className="flex flex-col gap-0.5">
            {servers
              .filter((server) => server.game === game)
              .map((server) => {
                const active = route.name === 'server' && route.id === server.id;
                return (
                  <li key={server.id}>
                    <Link
                      to={serverPath(server.id)}
                      aria-current={active ? 'page' : undefined}
                      className={cx('flex min-h-9 items-center gap-2.5 rounded-lg px-2.5 py-1.5 no-underline hover:bg-hover hover:text-ink', active ? 'bg-raised text-ink' : 'text-dim')}
                    >
                      <StatusLed server={server} status={statusFor(server)} />
                      <span className="truncate">{server.name}</span>
                    </Link>
                  </li>
                );
              })}
          </ul>
        </div>
      ))}
    </div>
  );
}

function Sidebar({ attention }: { attention: number }): ReactNode {
  const { route } = useRouter();
  const { t } = useI18n();
  const [serversOpen, setServersOpen] = useState(() => readFlag(KEY_SERVERS_OPEN, true));
  const subId = useId();
  const isNew = route.name === 'new' || route.name === 'new-game' || route.name === 'new-world';
  const onServer = route.name === 'server';
  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
        <nav aria-label={t.shell.mainNavigation} className="flex flex-col gap-0.5">
          <Link to="/" className={navClass(route.name === 'overview')} aria-current={route.name === 'overview' ? 'page' : undefined}>
            <LayoutGrid aria-hidden className="size-4 shrink-0" />
            {t.shell.overview}
          </Link>
          <button
            type="button"
            className={cx(navClass(false), onServer && 'text-accent')}
            aria-expanded={serversOpen}
            aria-controls={subId}
            onClick={() => {
              writeFlag(KEY_SERVERS_OPEN, !serversOpen);
              setServersOpen(!serversOpen);
            }}
          >
            <Server aria-hidden className="size-4 shrink-0" />
            {t.shell.servers}
            <span className="ml-auto flex items-center gap-2">
              {attention === 0 ? null : (
                <span title={t.shell.needAttention(attention)} className="num grid size-5 place-items-center rounded-full bg-bad-strong text-[11px] font-semibold leading-none text-white">
                  <span aria-hidden>{attention > 9 ? '9+' : attention}</span>
                  <span className="sr-only">{t.shell.needAttention(attention)}</span>
                </span>
              )}
              <ChevronDown aria-hidden className={cx('size-4 transition-transform', serversOpen && 'rotate-180')} />
            </span>
          </button>
          <div id={subId} hidden={!serversOpen} className="ml-[18px] border-l border-line py-1 pl-2">
            <ServerList />
          </div>
          <Link to="/new" className={navClass(isNew)} aria-current={isNew ? 'page' : undefined}>
            <Plus aria-hidden className="size-4 shrink-0" />
            {t.shell.newServer}
          </Link>
          <Link to="/games" className={navClass(route.name === 'games')} aria-current={route.name === 'games' ? 'page' : undefined}>
            <Gamepad2 aria-hidden className="size-4 shrink-0" />
            {t.games.nav}
          </Link>
          <Link to="/usage" className={navClass(route.name === 'usage')} aria-current={route.name === 'usage' ? 'page' : undefined}>
            <Activity aria-hidden className="size-4 shrink-0" />
            {t.usage.nav}
          </Link>
          <Link to="/system" className={navClass(route.name === 'system')} aria-current={route.name === 'system' ? 'page' : undefined}>
            <Settings aria-hidden className="size-4 shrink-0" />
            {t.shell.system}
          </Link>
        </nav>
      </div>
      <nav aria-label={t.shell.helpNavigation} className="flex flex-col gap-0.5 border-t border-line p-2.5">
        <a href={`${REPO_URL}#readme`} target="_blank" rel="noreferrer" className={navClass(false)}>
          <BookOpen aria-hidden className="size-4 shrink-0" />
          {t.shell.docs}
        </a>
        <a href={`${REPO_URL}/issues`} target="_blank" rel="noreferrer" className={navClass(false)}>
          <LifeBuoy aria-hidden className="size-4 shrink-0" />
          {t.shell.help}
        </a>
      </nav>
      <StorageBlock />
      <div className="border-t border-line p-3">
        <Disclaimer />
      </div>
    </>
  );
}

export function AppShell({ children }: { children: ReactNode }): ReactNode {
  const { visit } = useRouter();
  const { authRequired, logout } = useAuth();
  const { t } = useI18n();
  const { theme, toggle: toggleTheme } = useTheme();
  const attention = useAttention();
  const isDesktop = useIsDesktop();
  const [collapsed, setCollapsed] = useState(() => readFlag(KEY_COLLAPSED, false));
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const sidebarShown = isDesktop ? !collapsed : mobileOpen;

  // a navigation closes the menu that slid in over the content
  useEffect(() => setMobileOpen(false), [visit]);
  useEffect(() => {
    if (isDesktop || !mobileOpen) return;
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') setMobileOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isDesktop, mobileOpen]);

  const toggleSidebar = (): void => {
    if (isDesktop) {
      writeFlag(KEY_COLLAPSED, !collapsed);
      setCollapsed(!collapsed);
    } else setMobileOpen(!mobileOpen);
  };

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <header className="relative z-30 flex h-16 shrink-0 items-center gap-2 border-b border-line bg-panel/80 px-3 backdrop-blur-md sm:gap-3 sm:px-5">
        <button type="button" className="icon-btn" aria-label={t.shell.toggleMenu} aria-expanded={sidebarShown} aria-controls={SIDEBAR_ID} onClick={toggleSidebar}>
          <Menu aria-hidden className="size-5" />
        </button>
        <Brand />
        <ShellSearch open={searchOpen} onClose={() => setSearchOpen(false)} />
        <div className="ml-auto flex items-center gap-1 sm:gap-2">
          <button type="button" className="icon-btn md:hidden" aria-label={t.shell.openSearch} onClick={() => setSearchOpen(true)}>
            <Search aria-hidden className="size-4" />
          </button>
          <Link to="/new" className="btn-nav" aria-label={t.shell.newServer}>
            <Plus aria-hidden className="size-3.5 shrink-0" />
            <span className="hidden sm:inline">{t.shell.newServer}</span>
          </Link>
          <div className="flex items-center gap-0.5">
            <button type="button" className="icon-btn" aria-label={theme === 'dark' ? t.shell.themeToLight : t.shell.themeToDark} onClick={toggleTheme}>
              {theme === 'dark' ? <Sun aria-hidden className="size-4" /> : <Moon aria-hidden className="size-4" />}
            </button>
            <NotificationBell items={attention.items} />
          </div>
          {authRequired ? (
            <>
              <span role="img" aria-label={t.shell.signedIn} className="grid size-7 shrink-0 place-items-center rounded-full border border-line-strong bg-raised text-dim">
                <User aria-hidden className="size-4" />
              </span>
              <button type="button" className="hidden cursor-pointer border-0 bg-transparent p-0 text-sm font-medium text-dim hover:text-ink hover:underline sm:inline" onClick={() => void logout()}>
                {t.shell.logout}
              </button>
              <button type="button" className="icon-btn sm:hidden" aria-label={t.shell.logout} onClick={() => void logout()}>
                <LogOut aria-hidden className="size-4" />
              </button>
            </>
          ) : null}
        </div>
      </header>

      <div className="flex min-h-0 min-w-0 flex-1">
        {!isDesktop && mobileOpen ? <button type="button" aria-label={t.shell.closeMenu} className="fixed inset-0 top-16 z-10 cursor-default border-0 bg-black/50" onClick={() => setMobileOpen(false)} /> : null}
        <aside
          id={SIDEBAR_ID}
          inert={!sidebarShown}
          className={cx(
            'w-64 flex-col border-r border-line',
            isDesktop
              ? cx('shrink-0 bg-panel/70 backdrop-blur-md', collapsed ? 'hidden' : 'flex')
              : cx('fixed bottom-0 left-0 top-16 z-20 flex max-w-[85vw] bg-panel shadow-2xl transition-transform motion-reduce:transition-none', mobileOpen ? 'translate-x-0' : '-translate-x-full'),
          )}
        >
          {/* collapsed beside the content there is nothing to show; off screen on a phone it stays, so it can slide in */}
          {isDesktop && collapsed ? null : <Sidebar attention={attention.servers} />}
        </aside>

        {/* the frame fills the window; only this column scrolls, so the navbar and the sidebar stay in place */}
        <div id={SCROLL_ID} className="flex min-w-0 flex-1 flex-col overflow-y-auto">
          <ConnectionBanner />
          <UpdateBanner />
          <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-5 sm:px-6 lg:pb-8">{children}</main>
          {/* the sidebar carries the disclaimer; where it is not on screen, the foot of the page does */}
          {sidebarShown && isDesktop ? null : (
            <footer className="border-t border-line px-4 py-3 sm:px-6">
              <Disclaimer />
            </footer>
          )}
        </div>
      </div>
    </div>
  );
}
