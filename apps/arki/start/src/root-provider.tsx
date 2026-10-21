import { ThemeProvider } from '@arki/ui/theme';
import { AppProvider } from '@fleet/sitekit/app-context.tsx';

import config from '~/config';
import { registerArkiDesignSystem } from '~/styles/arki/register';
import { arkiThemeClasses, arkiThemes } from '~/styles/arki/themes';

// One stable array: the provider re-applies the theme whenever `themes` changes identity.
const siteThemes = [...arkiThemes];

// Runs when the app loads this module, so it is set before the first render on server and client.
registerArkiDesignSystem();

interface RootProviderProps {
  children: React.ReactNode;
}

/**
 * Providers every page uses, public pages included. Keep this list short: everything here ships in the JavaScript of
 * every docs page. What only signed-in pages need (auth, oRPC, toasts, tooltips) lives in `SignedInProviders`;
 * translations live in `LocaleProvider`, mounted only by the pages that read them.
 */
// designSystemId: the app's design system; arki.dev uses the arki brand system (must match styles/global.css)
export function RootProvider({ children }: RootProviderProps) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableColorScheme
      enableSystem
      themes={siteThemes}
      themeClasses={arkiThemeClasses}
    >
      <AppProvider appContext={config} designSystemId="arki">
        {children}
      </AppProvider>
    </ThemeProvider>
  );
}
