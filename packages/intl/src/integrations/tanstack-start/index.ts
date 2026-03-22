export { LocaleProvider, useLocale } from './context';

/** English-only: translation = key pass-through. */
export function useTranslations(_namespace?: string) {
  return (key: string, _params?: Record<string, unknown>) => key;
}

/** Always true for the default locale in a single-locale app. */
export function hasLocale(_locales: readonly string[], _locale: unknown): boolean {
  return true;
}

/** No-op provider — no next-intl context needed in TanStack Start. */
export function NextIntlClientProvider({
  children,
}: {
  children: React.ReactNode;
  locale?: string;
  messages?: unknown;
  timeZone?: string;
}): React.ReactNode {
  return children;
}

export type Locale = string;
export type AppConfig = Record<string, unknown>;
