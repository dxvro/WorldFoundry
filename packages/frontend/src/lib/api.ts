import type { ErrorBody, MessageParams } from '@worldfoundry/backend/contract';
import { errorMessage } from '../i18n/errorMessage';
import { getCurrentDictionary } from '../i18n/current';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    // the dynamic parts of the message (the error body's `params`); the translation of `code` uses them
    readonly params?: MessageParams,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const NETWORK_ERROR = 'NETWORK_ERROR';
export const INVALID_RESPONSE = 'INVALID_RESPONSE';

type QueryValue = string | number | boolean | undefined | readonly string[];

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, QueryValue>;
  signal?: AbortSignal;
  // login answers 401 for a wrong token; that is not a lost session
  ignoreUnauthorized?: boolean;
}

let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

export function buildQuery(query: Record<string, QueryValue> | undefined): string {
  if (query === undefined) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (typeof value === 'object') {
      if (value.length > 0) params.set(key, value.join(','));
    } else {
      params.set(key, String(value));
    }
  }
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

function isErrorBody(value: unknown): value is ErrorBody {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false;
  const error = (value as { error: unknown }).error;
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string' &&
    typeof (error as { message?: unknown }).message === 'string'
  );
}

export function errorFromResponse(status: number, text: string): ApiError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (isErrorBody(parsed)) return new ApiError(status, parsed.error.code, parsed.error.message, parsed.error.details, parsed.error.params);
  return new ApiError(status, `HTTP_${status}`, getCurrentDictionary().errors.unexpectedStatus(status));
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, query, signal, ignoreUnauthorized = false } = options;
  let response: Response;
  try {
    response = await fetch(`${path}${buildQuery(query)}`, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(0, NETWORK_ERROR, getCurrentDictionary().errors.codes.NETWORK_ERROR);
  }
  const text = await response.text();
  if (!response.ok) {
    const error = errorFromResponse(response.status, text);
    if (response.status === 401 && !ignoreUnauthorized) unauthorizedHandler?.();
    throw error;
  }
  if (text === '') return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(response.status, INVALID_RESPONSE, getCurrentDictionary().errors.codes.INVALID_RESPONSE);
  }
}

export const isAbort = (error: unknown): boolean => error instanceof DOMException && error.name === 'AbortError';

// The text for an error in the active language (known backend codes are translated, see i18n/errorMessage.ts).
export function describeError(error: unknown): string {
  return errorMessage(error, getCurrentDictionary());
}
