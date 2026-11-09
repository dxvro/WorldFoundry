import type { MessageKey, MessageParamsMap, MessageRef } from '@worldfoundry/backend/contract';
import type { en } from './locales/en';

// The interface is English only. The dictionary layer stays, so that every text lives in one place
// (locales/en/<namespace>.ts) and a further language can be added as a second dictionary of the same shape.
export type Lang = 'en';
export const LANGS: readonly Lang[] = ['en'];
export type Locale = 'en-US';
export const LOCALES: Record<Lang, Locale> = { en: 'en-US' };

export type Dictionary = typeof en;
export type Namespace<K extends keyof Dictionary> = Dictionary[K];

// The params of a message as a text function receives them: a nested reference (a reason, a label) arrives as its text
export type ResolvedParams<P> = { [N in keyof P]-?: P[N] extends MessageRef ? string : P[N] };
// One message of the `messages` namespace: a plain text when the key has no params, else a function of its params
export type MessageText<K extends MessageKey> = undefined extends MessageParamsMap[K]
  ? string
  : (params: ResolvedParams<MessageParamsMap[K]>) => string;
// Every key of the backend's message table (contract MessageKey) with its text; a missing key is a compile error
export type MessageTexts = { [K in MessageKey]: MessageText<K> };
