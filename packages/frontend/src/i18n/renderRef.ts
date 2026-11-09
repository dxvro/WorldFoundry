import type { MessageRef } from '@worldfoundry/backend/contract';
import type { Dictionary } from './types';

// Renders the references the backend sends next to its English texts (contract.ts: `xRef` beside `x`).
// A reference is a message key (the `messages` namespace), an AppError code (the `errors.codes` entries, with the
// params of the error) or MESSAGE_LIST (the references in params '1', '2', ... shown one after the other).
// Nested references in params (a reason, a label) are rendered first. When something cannot be rendered (no
// reference, unknown key, a required param missing, a nested part that fails) the given text is returned: the English
// text the backend sent.

type Values = Record<string, unknown>;
type Entry = string | ((values: Values) => string);

const hasOwn = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key);

export const isMessageRef = (value: unknown): value is MessageRef =>
  typeof value === 'object' && value !== null && typeof (value as { key?: unknown }).key === 'string';

// Calls a text function and reports whether it read a param that is not there. A function that needs a param must
// read it only when it is present (`'name' in p`), otherwise the English fallback is used.
function callTracked(fn: (values: Values) => string, values: Values): string | null {
  let missing = false;
  const proxy = new Proxy(values, {
    get(target, property, receiver) {
      if (typeof property === 'string' && !hasOwn(target, property)) missing = true;
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  try {
    const text = fn(proxy);
    return missing ? null : text;
  } catch {
    return null;
  }
}

// Renders the references among the params (a nested reference becomes its text); null when one of them fails
export function renderParams(params: Record<string, unknown>, t: Dictionary): Values | null {
  const values: Values = {};
  for (const [name, value] of Object.entries(params)) {
    if (isMessageRef(value)) {
      const text = resolveRef(value, t);
      if (text === null) return null;
      values[name] = text;
    } else {
      values[name] = value;
    }
  }
  return values;
}

// The text of an AppError code in the active language, or undefined when the code is not translated
export function codeEntry(t: Dictionary, code: string): Entry | undefined {
  if (!hasOwn(t.errors.codes, code)) return undefined;
  return (t.errors.codes as Record<string, Entry>)[code];
}

// Renders a message key or an error code with (already rendered) values; null when it cannot be rendered
function translateKey(key: string, values: Values, t: Dictionary): string | null {
  const messages = t.messages as unknown as Record<string, Entry>;
  if (hasOwn(messages, key)) {
    const entry = messages[key];
    if (typeof entry === 'string') return entry;
    if (typeof entry === 'function') return callTracked(entry, values);
  }
  const entry = codeEntry(t, key);
  if (typeof entry === 'string') return entry;
  if (typeof entry === 'function') return callTracked(entry, values);
  return null;
}

// The text of a reference in the active language, or null when it cannot be rendered
export function resolveRef(ref: MessageRef | null | undefined, t: Dictionary): string | null {
  if (ref === null || ref === undefined) return null;
  const params = ref.params ?? {};
  if (ref.key === 'MESSAGE_LIST') {
    const parts = Object.keys(params)
      .map(Number)
      .filter((index) => Number.isInteger(index) && index > 0)
      .sort((a, b) => a - b)
      .map((index) => params[String(index)]);
    if (parts.length === 0) return null;
    const texts: string[] = [];
    for (const part of parts) {
      if (!isMessageRef(part)) return null;
      const text = resolveRef(part, t);
      if (text === null) return null;
      texts.push(text);
    }
    return texts.join(' ');
  }
  const values = renderParams(params, t);
  if (values === null) return null;
  return translateKey(ref.key, values, t);
}

// Text of a reference in the active language; the given text (the backend's English one) when it cannot be rendered
export function renderRef(ref: MessageRef | null | undefined, t: Dictionary, fallback: string): string {
  return resolveRef(ref, t) ?? fallback;
}

// Text of an optional reference: undefined when there is neither a reference nor a text
export function renderOptionalRef(ref: MessageRef | null | undefined, t: Dictionary, fallback: string | null | undefined): string | undefined {
  if (ref === null || ref === undefined) return fallback ?? undefined;
  return resolveRef(ref, t) ?? fallback ?? undefined;
}
