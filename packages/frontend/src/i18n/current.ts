import { en } from './locales/en';
import type { Dictionary, Locale } from './types';

// For plain (non-React) helpers such as lib/format.ts, which cannot use the useI18n hook.
export const getCurrentLocale = (): Locale => 'en-US';
export const getCurrentDictionary = (): Dictionary => en;
