import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, buildQuery, errorFromResponse, request, setUnauthorizedHandler } from './api';
import { authApi, serversApi } from './endpoints';

const respond = (status: number, body: string): Response => new Response(body, { status });

describe('error mapping', () => {
  it('keeps code, German message and details of the backend error body', () => {
    const error = errorFromResponse(409, JSON.stringify({ error: { code: 'MOD_REQUIRED_BY_OTHERS', message: 'Is required.', details: { dependents: [{ id: '1', name: 'A' }] } } }));
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: 'MOD_REQUIRED_BY_OTHERS', message: 'Is required.', details: { dependents: [{ id: '1', name: 'A' }] } });
  });

  it('falls back to a German message for bodies that are not the error shape', () => {
    expect(errorFromResponse(502, '<html>Bad Gateway</html>')).toMatchObject({ status: 502, code: 'HTTP_502', message: expect.stringContaining('502') });
    expect(errorFromResponse(500, JSON.stringify({ error: 'x' }))).toMatchObject({ code: 'HTTP_500' });
    expect(errorFromResponse(500, '')).toMatchObject({ code: 'HTTP_500' });
  });
});

describe('request', () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setUnauthorizedHandler(null);
  });

  it('throws the backend error for non-2xx responses', async () => {
    fetchMock.mockResolvedValue(respond(404, JSON.stringify({ error: { code: 'SERVER_NOT_FOUND', message: 'The server was not found.' } })));
    await expect(request('/api/servers/x')).rejects.toMatchObject({ status: 404, code: 'SERVER_NOT_FOUND', message: 'The server was not found.' });
  });

  it('maps a network failure to NETWORK_ERROR with a German message', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(request('/api/health')).rejects.toMatchObject({ status: 0, code: 'NETWORK_ERROR', message: expect.stringContaining('cannot be reached') });
  });

  it('rejects an unreadable success body', async () => {
    fetchMock.mockResolvedValue(respond(200, 'not json'));
    await expect(request('/api/health')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('sends bodyless POSTs without body and content type, JSON bodies with both', async () => {
    fetchMock.mockResolvedValue(respond(200, JSON.stringify({ status: {} })));
    await serversApi.stop('abc');
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/servers/abc/stop');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).has('content-type')).toBe(false);

    fetchMock.mockResolvedValue(respond(200, JSON.stringify({ server: {}, restartRequired: false })));
    await serversApi.update('abc', { name: 'Neu' });
    const second = fetchMock.mock.calls[1]?.[1];
    expect(second?.body).toBe(JSON.stringify({ name: 'Neu' }));
    expect(new Headers(second?.headers).get('content-type')).toBe('application/json');
  });

  it('tolerates an empty success body', async () => {
    fetchMock.mockResolvedValue(respond(200, ''));
    await expect(request('/api/x')).resolves.toBeUndefined();
  });

  it('calls the unauthorized handler on 401, except for the login request', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    const unauthorized = JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Anmeldung erforderlich.' } });
    fetchMock.mockResolvedValue(respond(401, unauthorized));
    await expect(serversApi.list()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(handler).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValue(respond(401, JSON.stringify({ error: { code: 'INVALID_TOKEN', message: 'The access token is invalid.' } })));
    await expect(authApi.login('wrong')).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('builds query strings without empty values and joins lists', () => {
    expect(buildQuery(undefined)).toBe('');
    expect(buildQuery({ a: undefined, b: '', c: [], d: ['x', 'y'], e: true, f: 0 })).toBe('?b=&d=x%2Cy&e=true&f=0');
  });
});
