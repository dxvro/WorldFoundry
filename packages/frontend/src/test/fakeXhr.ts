import { vi } from 'vitest';

// Stands in for XMLHttpRequest in the upload tests: reports progress, then answers with the prepared body.
export class FakeXhr {
  static sent: Array<{ method: string; url: string; size: number | null; headers: Record<string, string> }> = [];
  static answer: { status: number; body: unknown } = { status: 202, body: {} };

  upload: { onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  status = 0;
  responseText = '';
  private method = '';
  private url = '';
  private headers: Record<string, string> = {};

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }
  send(body: File): void {
    FakeXhr.sent.push({ method: this.method, url: this.url, size: body.size, headers: this.headers });
    setTimeout(() => {
      this.upload.onprogress?.({ lengthComputable: true, loaded: body.size / 2, total: body.size });
      this.status = FakeXhr.answer.status;
      this.responseText = JSON.stringify(FakeXhr.answer.body);
      this.onload?.();
    }, 0);
  }
  abort(): void {
    this.onabort?.();
  }

  static install(answer: { status: number; body: unknown }): void {
    FakeXhr.sent = [];
    FakeXhr.answer = answer;
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
  }
}
