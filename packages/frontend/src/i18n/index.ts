// Adding a text: put it into src/i18n/locales/en/<namespace>.ts (nested keys; values are strings, or functions like
// `(n: number) => ...` for interpolation and plurals) and use it with `const { t } = useI18n(); ... {t.backups.count(3)}`.
// Outside React use `getCurrentDictionary()`. Show errors with `<ErrorNotice>` / `errorMessage(e, t)`.
export { I18nProvider, useI18n, type I18n } from './I18nProvider';
export { errorMessage } from './errorMessage';
export { renderOptionalRef, renderRef, resolveRef } from './renderRef';
export { getCurrentDictionary, getCurrentLocale } from './current';
export { type Dictionary, type Lang, type Locale, type Namespace } from './types';
export { en } from './locales/en';
