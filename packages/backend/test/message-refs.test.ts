import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listenWithFallback } from '../src/network/boot.js';
import { AppError, errorMsg, errorRef } from '../src/http/errors.js';
import { joinMsgs, msg, MsgList, parseRef, refsOf, serializeRef, textsOf } from '../src/messages.js';
import { ServerEnv } from './server-env.js';

describe('message references', () => {
  it('builds the English text and the reference from one template', () => {
    expect(msg('JAVA_INSTALLING', { major: 21 })).toEqual({ text: 'Installing Java 21 ...', ref: { key: 'JAVA_INSTALLING', params: { major: 21 } } });
    // a message without parameters has no params field at all
    expect(msg('SERVER_STOPPING')).toEqual({ text: 'Stopping the server ...', ref: { key: 'SERVER_STOPPING' } });
  });

  it('nests a message as a parameter: the text is in the sentence, the wire form carries the inner reference', () => {
    const reason = msg('JAVA_INSTALLING', { major: 8 });
    const outer = msg('START_FAILED_REASON', { reason });
    expect(outer.text).toBe('The server could not be started: Installing Java 8 ...');
    expect(outer.ref).toEqual({ key: 'START_FAILED_REASON', params: { reason: { key: 'JAVA_INSTALLING', params: { major: 8 } } } });
  });

  it('joins messages into one text with a MESSAGE_LIST reference, or none when a part has no key', () => {
    const a = msg('SAVE_ON_UNCONFIRMED');
    const b = msg('BACKUP_NOTE_SYMLINKS', { count: 2 });
    expect(joinMsgs([])).toBeNull();
    expect(joinMsgs([a])).toEqual({ text: a.text, ref: a.ref });
    expect(joinMsgs([a, b])).toEqual({ text: `${a.text} ${b.text}`, ref: { key: 'MESSAGE_LIST', params: { '1': a.ref, '2': b.ref } } });
    expect(joinMsgs([a, 'plain legacy text'])).toEqual({ text: `${a.text} plain legacy text`, ref: null });
    expect(textsOf([a, 'x'])).toEqual([a.text, 'x']);
    expect(refsOf([a, 'x'])).toEqual([a.ref, null]);
  });

  it('collects warnings as parallel lists', () => {
    const list = new MsgList();
    list.push(msg('MOD_DEPENDENCY_ENABLED', { name: 'Beta' }));
    expect(list.length).toBe(1);
    expect(list.texts).toEqual(['"Beta" was disabled and has also been enabled as a required dependency.']);
    expect(list.refs).toEqual([{ key: 'MOD_DEPENDENCY_ENABLED', params: { name: 'Beta' } }]);
  });

  it('stores references as JSON and reads missing or damaged values as none', () => {
    const ref = msg('UPDATE_SUCCESS', { version: '1.2.3' }).ref;
    expect(parseRef(serializeRef(ref))).toEqual(ref);
    expect(serializeRef(null)).toBeNull();
    expect(parseRef(null)).toBeNull();
    expect(parseRef('not json')).toBeNull();
    expect(parseRef('{"no":"key"}')).toBeNull();
  });
});

describe('error references', () => {
  it('uses the code as the key and the params as dynamic parts; params double as details when there are none', () => {
    const plain = new AppError(502, 'UPSTREAM_UNREACHABLE', 'The service "x" is not reachable.', undefined, { host: 'x' });
    expect(plain.details).toEqual({ host: 'x' });
    expect(errorRef(plain)).toEqual({ key: 'UPSTREAM_UNREACHABLE', params: { host: 'x' } });
    // explicit details stay as they were
    const withDetails = new AppError(409, 'JAVA_IN_USE', 'in use', { servers: [1] }, { major: 21 });
    expect(withDetails.details).toEqual({ servers: [1] });
    expect(withDetails.params).toEqual({ major: 21 });
    // an error without params has a key only
    expect(errorRef(new AppError(404, 'SERVER_NOT_FOUND', 'x'))).toEqual({ key: 'SERVER_NOT_FOUND' });
  });

  it('turns any failure into a message: the AppError itself, otherwise the fallback', () => {
    const fallback = msg('BACKUP_UNEXPECTED');
    expect(errorMsg(new Error('boom'), fallback)).toBe(fallback);
    expect(errorMsg(new AppError(409, 'BACKUP_IN_PROGRESS', 'busy'), fallback)).toEqual({ text: 'busy', ref: { key: 'BACKUP_IN_PROGRESS' } });
    // a wrapper error can name its own key
    const wrapped = new AppError(409, 'DISK_FULL', 'The server "S" was created, but ...', undefined, undefined, { key: 'IMPORT_PARTIAL', params: { name: 'S' } });
    expect(errorMsg(wrapped, fallback).ref).toEqual({ key: 'IMPORT_PARTIAL', params: { name: 'S' } });
  });

  it('sends params next to the message in the error body', async () => {
    const env = await ServerEnv.create();
    try {
      const bad = await env.call<{ error: { code: string; message: string; params?: Record<string, unknown>; details?: unknown } }>('PUT', '/api/system/network', {
        allowedHosts: ['good.fritz.box', 'http://bad'],
      });
      expect(bad.status).toBe(422);
      expect(bad.body.error).toMatchObject({ code: 'NETWORK_HOST_INVALID', params: { hosts: 'http://bad' }, details: { hosts: 'http://bad' } });
      expect(bad.body.error.message).toContain('http://bad');
      // an error without dynamic parts has neither
      const missing = await env.call<{ error: Record<string, unknown> }>('GET', '/api/servers/nope');
      expect(missing.body.error).toEqual({ code: 'SERVER_NOT_FOUND', message: 'The server was not found.' });
    } finally {
      await env.close();
    }
  });
});

describe('references in the API', () => {
  let env: ServerEnv;
  beforeEach(async () => {
    env = await ServerEnv.create();
  });
  afterEach(async () => {
    await env.close();
  });

  it('shows stored install errors with or without a reference', async () => {
    const legacy = await env.addServer({ installState: 'failed', installError: 'Die Installation ist fehlgeschlagen.' });
    const modern = await env.addServer({
      installState: 'failed',
      installError: 'The installation was interrupted (the application was shut down).',
      installErrorRef: JSON.stringify({ key: 'INSTALL_INTERRUPTED_SHUTDOWN' }),
    });
    const list = (await env.call<{ servers: Array<{ id: string; installError: string | null; installErrorRef: unknown }> }>('GET', '/api/servers')).body.servers;
    // an old row has only its text; the client shows it as it is
    expect(list.find((server) => server.id === legacy.id)).toMatchObject({ installError: 'Die Installation ist fehlgeschlagen.', installErrorRef: null });
    expect(list.find((server) => server.id === modern.id)).toMatchObject({ installErrorRef: { key: 'INSTALL_INTERRUPTED_SHUTDOWN' } });
  });

  it('marks interrupted installations with a reference at boot', async () => {
    const stuck = await env.addServer({ installState: 'installing' });
    expect(await env.services.install.recoverInterrupted()).toBe(1);
    const body = (await env.call<{ server: { installError: string; installErrorRef: unknown } }>('GET', `/api/servers/${stuck.id}`)).body.server;
    expect(body).toMatchObject({ installErrorRef: { key: 'INSTALL_INTERRUPTED_SHUTDOWN' } });
    expect(body.installError).toContain('interrupted');
  });

  it('puts a key on the system lines written by WorldFoundry, not on server output', async () => {
    const server = await env.addServer();
    await env.call('POST', `/api/servers/${server.id}/start`);
    await env.waitState(server.id, 'online');
    await env.call('POST', `/api/servers/${server.id}/stop`);
    await env.waitState(server.id, 'offline');
    const lines = env.services.manager.history(server.id);
    const system = lines.filter((line) => line.stream === 'system');
    expect(system.length).toBeGreaterThan(0);
    expect(system.every((line) => line.textRef !== undefined)).toBe(true);
    expect(system.map((line) => line.textRef?.key)).toEqual(expect.arrayContaining(['SERVER_STARTING', 'SERVER_STOPPING', 'SERVER_STOPPED']));
    expect(lines.filter((line) => line.stream !== 'system').every((line) => line.textRef === undefined)).toBe(true);
    // the key comes back in the status after a failed start
    env.services.manager.markStartFailed(server.id, msg('AUTOSTART_FAILED', { reason: msg('START_UNEXPECTED_ERROR') }));
    const status = env.services.manager.status(server.id);
    expect(status).toMatchObject({ state: 'crashed', messageRef: { key: 'AUTOSTART_FAILED', params: { reason: { key: 'START_UNEXPECTED_ERROR' } } } });
    expect(status.message).toBe('Autostart failed: Unexpected error while starting.');
    // a plain string (no key) still works and leaves the reference empty
    env.services.manager.markStartFailed(server.id, 'something else');
    expect(env.services.manager.status(server.id)).toMatchObject({ message: 'something else', messageRef: null });
  });
});

describe('network warnings', () => {
  it('carries the fallback reasons with their keys', async () => {
    const failure = (code: string): Error => Object.assign(new Error(code), { code });
    let first = true;
    const result = await listenWithFallback(
      async () => {
        if (first) {
          first = false;
          throw failure('EADDRNOTAVAIL');
        }
      },
      { host: '10.9.9.9', port: 3100, defaultPort: 3000 },
    );
    expect(result.host).toBe('0.0.0.0');
    expect(result.warnings).toHaveLength(1);
    expect(result.warningRefs).toEqual([{ key: 'NETWORK_ADDRESS_MISSING', params: { host: '10.9.9.9' } }]);
  });
});
