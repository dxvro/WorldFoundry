export const MAX_COMMAND_HISTORY = 100;

// Shell-like command recall: up goes back in time, down returns to the unsent draft.
export class CommandHistory {
  private entries: string[];
  private cursor: number;
  private draft = '';

  constructor(initial: readonly string[] = []) {
    this.entries = initial.slice(-MAX_COMMAND_HISTORY);
    this.cursor = this.entries.length;
  }

  get items(): readonly string[] {
    return this.entries;
  }

  push(command: string): void {
    const trimmed = command.trim();
    if (trimmed !== '' && this.entries[this.entries.length - 1] !== trimmed) {
      this.entries.push(trimmed);
      if (this.entries.length > MAX_COMMAND_HISTORY) this.entries.shift();
    }
    this.cursor = this.entries.length;
    this.draft = '';
  }

  // current is what the input shows right now; it is kept as the draft when leaving the newest position
  previous(current: string): string | null {
    if (this.entries.length === 0 || this.cursor === 0) return null;
    if (this.cursor === this.entries.length) this.draft = current;
    this.cursor--;
    return this.entries[this.cursor] ?? null;
  }

  next(): string | null {
    if (this.cursor >= this.entries.length) return null;
    this.cursor++;
    return this.cursor === this.entries.length ? this.draft : (this.entries[this.cursor] ?? null);
  }

  resetCursor(): void {
    this.cursor = this.entries.length;
  }
}

const storageKey = (serverId: string): string => `worldfoundry.commands.${serverId}`;

// localStorage works on plain http, but may throw (private mode, blocked storage): history then lives in memory only
export function loadHistory(serverId: string): string[] {
  try {
    const raw = window.localStorage.getItem(storageKey(serverId));
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

export function saveHistory(serverId: string, entries: readonly string[]): void {
  try {
    window.localStorage.setItem(storageKey(serverId), JSON.stringify(entries));
  } catch {
    // storage unavailable
  }
}
