import type { Db } from '../db/client.js';
import type { CredentialSource } from '../http/auth.js';
import { SettingsStore } from '../settings/store.js';

export const KEY_PASSWORD = 'auth.password';

// The scrypt record of the web password in app_settings (one transaction per write)
export class PasswordStore implements CredentialSource {
  private readonly settings: SettingsStore;

  constructor(db: Db, now?: () => number) {
    this.settings = new SettingsStore(db, now);
  }

  load(): Promise<string | null> {
    return this.settings.get(KEY_PASSWORD);
  }

  save(record: string): Promise<void> {
    return this.settings.set(KEY_PASSWORD, record);
  }
}
