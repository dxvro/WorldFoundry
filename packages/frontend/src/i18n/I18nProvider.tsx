import { createContext, useContext, type ReactNode } from 'react';
import { en } from './locales/en';
import type { Dictionary, Locale } from './types';

export interface I18n {
  // the typed dictionary
  t: Dictionary;
  // BCP 47 locale for Intl / toLocale*String
  locale: Locale;
}

const VALUE: I18n = { t: en, locale: 'en-US' };
const I18nContext = createContext<I18n>(VALUE);

export function I18nProvider({ children }: { children: ReactNode }): ReactNode {
  return <I18nContext.Provider value={VALUE}>{children}</I18nContext.Provider>;
}

export const useI18n = (): I18n => useContext(I18nContext);
