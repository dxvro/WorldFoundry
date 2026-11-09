import type { BackupKind, BackupStatus, InstallState } from '../db/enums.js';
import type { MessageRef } from '../messages.js';
import type { RuntimeStatus } from '../process/types.js';
import type { SystemUpdateState } from '../update/types.js';

export type AppEvent =
  | { type: 'server.status'; serverId: string; status: RuntimeStatus }
  | { type: 'server.metrics'; serverId: string; cpuPercent: number | null; rssBytes: number | null }
  | { type: 'server.changed'; serverId: string; reason: 'created' | 'updated' | 'deleted' }
  | { type: 'server.crashed'; serverId: string; exitCode: number | null; lastLines: string[]; lastLinesRefs: Array<MessageRef | null> }
  | { type: 'install.state'; serverId: string; installState: InstallState; installError: string | null; installErrorRef: MessageRef | null }
  | { type: 'install.progress'; serverId: string; phase: string; percent: number | null; message: string; messageRef: MessageRef | null }
  // seq is the zero-based line number in install.log, so a reader can merge the file with live events
  | { type: 'install.log'; serverId: string; line: string; seq: number; time: number }
  | {
      type: 'java.install';
      major: number;
      state: 'running' | 'done' | 'failed';
      phase: string;
      percent: number | null;
      message: string;
      messageRef: MessageRef | null;
      error: string | null;
      errorRef: MessageRef | null;
    }
  | { type: 'backup.changed'; serverId: string; backupId: string; kind: BackupKind; status: BackupStatus | 'deleted'; error: string | null; errorRef: MessageRef | null }
  // the application is about to stop for a deliberate restart; urls are the addresses to open afterwards
  | { type: 'system.restarting'; urls: string[] }
  // the whole state of the self-update (sent on every change; the progress is throttled)
  | { type: 'update.state'; state: SystemUpdateState }
  | {
      type: 'mods.updates';
      serverId: string;
      ok: boolean;
      count: number;
      projects: string[];
      error: string | null;
      errorRef: MessageRef | null;
    };

export type AppEventListener = (event: AppEvent) => void;

export class EventBus {
  private readonly listeners = new Set<AppEventListener>();

  subscribe(listener: AppEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: AppEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // a faulty subscriber must never break the emitter
      }
    }
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}
