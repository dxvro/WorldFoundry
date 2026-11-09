import { rename } from 'node:fs/promises';

const RETRY_CODES: readonly string[] = ['EPERM', 'EBUSY', 'EACCES'];

// Windows briefly locks fresh files (virus scanners, search indexer); a rename is worth retrying a few times
export async function renameWithRetry(from: string, to: string, retries = 12, delayMs = 150): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= retries || code === undefined || !RETRY_CODES.includes(code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
