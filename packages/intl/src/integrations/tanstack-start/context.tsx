import { createContext, useContext } from 'react';
import { IntlProvider } from 'use-intl';

const LocaleContext = createContext<string>('en');

/**
 * Provides locale to TanStack Start apps.
 *
 * Mounts `use-intl`'s `IntlProvider` so shared components that call
 * `useLocale()` / `useTranslations()` from `use-intl` (e.g. `@fleet/sitekit`)
 * resolve context correctly under Vite SSR.
 */
export const LocaleProvider = ({
  locale = 'en',
  messages = {},
  timeZone = 'UTC',
  children,
}: {
  locale?: string;
  messages?: Record<string, unknown>;
  /**
   * Explicit IANA time zone for use-intl date/number formatting. Required for
   * deterministic SSR: without it, use-intl falls back to the runtime time zone
   * (UTC in Docker, local on the client) and emits `ENVIRONMENT_FALLBACK`,
   * risking hydration mismatches. Defaults to `'UTC'`.
   */
  timeZone?: string;
  children: React.ReactNode;
}) => (
  <LocaleContext.Provider value={locale}>
    <IntlProvider locale={locale} messages={messages} timeZone={timeZone}>
      {children}
    </IntlProvider>
  </LocaleContext.Provider>
);

export const useLocale = (): string => useContext(LocaleContext);
