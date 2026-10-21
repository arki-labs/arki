import { ThemeProvider } from '@arki/theme';
import { AppProvider } from '@fleet/sitekit/app-context.tsx';

import config from '~/config';

interface RootProviderProps {
  children: React.ReactNode;
}

/**
 * Providers every page uses, public pages included. Keep this list short: everything here ships in the JavaScript of
 * every docs page. What only signed-in pages need (auth, oRPC, toasts, tooltips) lives in `SignedInProviders`;
 * translations live in `LocaleProvider`, mounted only by the pages that read them.
 */
// designSystemId: set to 'atelier', 'workbench', or 'arena' based on the app's design system
export function RootProvider({ children }: RootProviderProps) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableColorScheme enableSystem>
      <AppProvider appContext={config} designSystemId="atelier">
        {children}
      </AppProvider>
    </ThemeProvider>
  );
}
