import { useCallback, useState } from 'react';

export type Theme = 'dark' | 'light';

const KEY = 'worldfoundry.theme';

// dark unless the user chose the light theme on this device
export function storedTheme(): Theme {
  try {
    return window.localStorage.getItem(KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(storedTheme);
  const toggle = useCallback(() => {
    setTheme((current) => {
      const next: Theme = current === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      try {
        window.localStorage.setItem(KEY, next);
      } catch {
        // private windows may refuse storage; the choice then lasts until the page is reloaded
      }
      return next;
    });
  }, []);
  return { theme, toggle };
}
