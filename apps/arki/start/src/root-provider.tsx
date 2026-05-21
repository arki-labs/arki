import { NuqsAdapter } from 'nuqs/adapters/tanstack-router';

import { AppLocaleProvider } from '@arki/intl/tanstack-start';
import { ThemeProvider } from '@arki/theme';

import { Providers } from './providers';
import { ORPCReactProvider } from './lib/orpc/client';

interface RootProviderProps {
  locale: string;
  children: React.ReactNode;
}

export function RootProvider({ locale, children }: RootProviderProps) {
  return (
    <AppLocaleProvider locale={locale}>
      <ORPCReactProvider>
        <ThemeProvider attribute="class" defaultTheme="system" enableColorScheme enableSystem>
          <NuqsAdapter>
            <Providers>{children}</Providers>
          </NuqsAdapter>
        </ThemeProvider>
      </ORPCReactProvider>
    </AppLocaleProvider>
  );
}
