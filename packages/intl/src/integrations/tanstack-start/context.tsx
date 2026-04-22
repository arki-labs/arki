import { createContext, useContext } from 'react';
import { IntlProvider } from 'use-intl';

const LocaleContext = createContext<string>('en');

/**
 * Provides locale to TanStack Start apps.
 *
 * Mounts `use-intl`'s `IntlProvider` so shared components that call
 * `useLocale()` / `useTranslations()` from `use-intl` (e.g. `@arki/sitekit`)
 * resolve context correctly under Vite SSR.
 */
export const LocaleProvider = ({
  locale = 'en',
  messages = {},
  children,
}: {
  locale?: string;
  messages?: Record<string, unknown>;
  children: React.ReactNode;
}) => (
  <LocaleContext.Provider value={locale}>
    <IntlProvider locale={locale} messages={messages}>
      {children}
    </IntlProvider>
  </LocaleContext.Provider>
);

export const useLocale = (): string => useContext(LocaleContext);
