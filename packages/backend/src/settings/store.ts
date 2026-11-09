import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { appSettings } from '../db/schema.js';

// Key/value access to app_settings. Every write is one transaction and nothing is awaited inside it.
export class SettingsStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  async get(key: string): Promise<string | null> {
    const rows = await this.db.select().from(appSettings).where(eq(appSettings.key, key));
    return rows[0]?.value ?? null;
  }

  async set(key: string, value: string | null): Promise<void> {
    const at = new Date(this.now());
    await this.db.transaction(async (tx) => {
      if (value === null) {
        await tx.delete(appSettings).where(eq(appSettings.key, key));
      } else {
        await tx.insert(appSettings).values({ key, value, updatedAt: at }).onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: at } });
      }
    });
  }

  // reads a JSON value; anything unreadable counts as "not set"
  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.get(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }
}
