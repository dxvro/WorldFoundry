import { ApiError } from '../lib/api';
import { codeEntry, renderParams } from './renderRef';
import type { Dictionary } from './types';

// Turns any thrown value into text for the active language. For a known error `code` the text comes from
// `t.errors.codes` in both languages (the backend message is English and not needed then). The code's function gets
// the error's `params` first and its `details` second. The backend's own message is only shown for codes that are not
// in the dictionary, for a nested reference that cannot be rendered, and for plain errors.
export function errorMessage(error: unknown, t: Dictionary): string {
  if (error instanceof ApiError) {
    const entry = codeEntry(t, error.code);
    if (entry === undefined) {
      if (error.code.startsWith('HTTP_')) return t.errors.unexpectedStatus(error.status);
      return error.message;
    }
    if (typeof entry === 'string') return entry;
    const details = typeof error.details === 'object' && error.details !== null ? (error.details as Record<string, unknown>) : {};
    const params = renderParams(error.params ?? {}, t);
    if (params === null) return error.message;
    return entry({ ...details, ...params });
  }
  if (error instanceof Error) return error.message;
  return t.errors.unknown;
}
