// Small per-device preferences (a collapsed sidebar). Storage can be refused; the default then applies.
export function readFlag(key: string, fallback: boolean): boolean {
  try {
    const value = window.localStorage.getItem(key);
    return value === null ? fallback : value === '1';
  } catch {
    return fallback;
  }
}

export function writeFlag(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // nothing to do: the preference lasts until the page is reloaded
  }
}
