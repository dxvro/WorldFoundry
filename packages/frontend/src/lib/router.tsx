import { createContext, useCallback, useContext, useEffect, useMemo, useState, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from 'react';

export const SERVER_TABS = ['console', 'config', 'world', 'players', 'mods', 'store', 'backups'] as const;
export type ServerTab = (typeof SERVER_TABS)[number];

export type Route =
  | { name: 'overview' }
  | { name: 'new' }
  | { name: 'system' }
  | { name: 'new-world' }
  | { name: 'server'; id: string; tab: ServerTab }
  | { name: 'not-found' };

const isTab = (value: string): value is ServerTab => (SERVER_TABS as readonly string[]).includes(value);

export function parseRoute(pathname: string): Route {
  const parts = pathname.split('/').filter((part) => part !== '');
  if (parts.length === 0) return { name: 'overview' };
  if (parts.length === 1 && parts[0] === 'new') return { name: 'new' };
  if (parts.length === 1 && parts[0] === 'system') return { name: 'system' };
  if (parts.length === 2 && parts[0] === 'new' && parts[1] === 'world') return { name: 'new-world' };
  if (parts[0] === 'servers' && parts.length <= 3 && parts[1] !== undefined) {
    let id: string;
    try {
      id = decodeURIComponent(parts[1]);
    } catch {
      return { name: 'not-found' };
    }
    const tab = parts[2] ?? 'console';
    return isTab(tab) ? { name: 'server', id, tab } : { name: 'not-found' };
  }
  return { name: 'not-found' };
}

export const serverPath = (id: string, tab: ServerTab = 'console'): string => `/servers/${encodeURIComponent(id)}${tab === 'console' ? '' : `/${tab}`}`;

interface RouterValue {
  route: Route;
  // changes on every navigation, even to the same address, so a page can start over
  visit: number;
  navigate: (to: string, options?: { replace?: boolean }) => void;
}

const RouterContext = createContext<RouterValue | null>(null);

export function RouterProvider({ children }: { children: ReactNode }): ReactNode {
  const [pathname, setPathname] = useState(() => window.location.pathname);
  const [visit, setVisit] = useState(0);

  useEffect(() => {
    const onPop = (): void => setPathname(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((to: string, options?: { replace?: boolean }) => {
    if (options?.replace === true) window.history.replaceState(null, '', to);
    else window.history.pushState(null, '', to);
    setPathname(window.location.pathname);
    setVisit((value) => value + 1);
    window.scrollTo(0, 0);
  }, []);

  const value = useMemo<RouterValue>(() => ({ route: parseRoute(pathname), visit, navigate }), [pathname, visit, navigate]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter(): RouterValue {
  const value = useContext(RouterContext);
  // a programming error, not user-facing text: kept in English
  if (value === null) throw new Error('useRouter must be used inside RouterProvider.');
  return value;
}

interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  to: string;
}

export function Link({ to, onClick, children, ...rest }: LinkProps): ReactNode {
  const { navigate } = useRouter();
  const handleClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(to);
  };
  return (
    <a href={to} onClick={handleClick} {...rest}>
      {children}
    </a>
  );
}
