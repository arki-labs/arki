export { LocaleProvider, useLocale } from './context';

// Re-export next-intl hooks for convenience — context is provided by LocaleProvider.
export { hasLocale, NextIntlClientProvider, useTranslations } from 'next-intl';

export type { AppConfig, Locale } from 'next-intl';
