import { createContext, useContext } from 'react';
import { NextIntlClientProvider } from 'next-intl';

const LocaleContext = createContext<string>('en');

/**
 * Provides locale to TanStack Start apps.
 *
 * Also mounts next-intl/use-intl context so that @arki/sitekit components
 * that call useLocale() or useTranslations() from use-intl work without
 * requiring a separate NextIntlClientProvider.
 */
export const LocaleProvider = ({
  locale = 'en',
  children,
}: {
  locale?: string;
  children: React.ReactNode;
}) => (
  <LocaleContext.Provider value={locale}>
    <NextIntlClientProvider locale={locale} messages={{}}>
      {children}
    </NextIntlClientProvider>
  </LocaleContext.Provider>
);

export const useLocale = (): string => useContext(LocaleContext);
