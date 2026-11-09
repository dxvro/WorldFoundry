import { createClient, type Client } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { pathToFileURL } from 'node:url';
import { KeyedLock } from '../lib/keyed-lock.js';
import * as schema from './schema.js';

export type Db = LibSQLDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface DbHandle {
  db: Db;
  client: Client;
  close: () => void;
}

export async function openDb(filePath: string): Promise<DbHandle> {
  // pathToFileURL yields file:///C:/... on Windows, which libsql accepts
  const client = createClient({ url: pathToFileURL(filePath).href });
  try {
    await client.execute('PRAGMA journal_mode=WAL');
    await client.execute('PRAGMA foreign_keys=ON');
    // libsql's pool opens connections lazily and PRAGMAs are per connection, so we only
    // rely on the library default (foreign_keys=1 on every connection) and verify it.
    const row = (await client.execute('PRAGMA foreign_keys')).rows[0];
    if (row?.['foreign_keys'] !== 1) {
      throw new Error('SQLite foreign_keys could not be enabled.');
    }
  } catch (error) {
    client.close();
    throw error;
  }
  return { db: serializeWrites(drizzle(client, { schema })), client, close: () => client.close() };
}

// libsql calls are synchronous: a second connection that hits a held write lock blocks the event
// loop, so the holder can never commit (SQLITE_BUSY even with a busy timeout). All writes therefore
// go through db.transaction(), and transactions are queued here so only one is open at a time.
function serializeWrites(db: Db): Db {
  const lock = new KeyedLock();
  const original = db.transaction.bind(db) as (...args: unknown[]) => Promise<unknown>;
  db.transaction = ((...args: unknown[]) => lock.run('write', () => original(...args))) as Db['transaction'];
  return db;
}
