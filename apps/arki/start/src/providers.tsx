import { createStore, Provider } from 'jotai';
import { DevTools } from 'jotai-devtools';

import type { NavContextType } from '@arki/sitekit/nav-context.tsx';
import { FullscreenProvider } from '@arki/react-fullscreen';
import { useIsClient } from '@arki/react-hooks/is-client';
import { AppProvider } from '@arki/sitekit/app-context.tsx';
import { ArkiAuthProvider } from '@arki/auth/tanstack-start';
import { NavContextProvider } from '@arki/sitekit/nav-context.tsx';
import { useTheme } from '@arki/theme';
import { TooltipProvider } from '@arki/ui/tooltip';

import config from '~/config';
import { env } from './env';
import { authClient } from './features/auth/client';
import { DBProvider } from './lib/db/provider';

const customStore = createStore();

function DevToolsWrapper() {
  const { resolvedTheme } = useTheme();
  const isClient = useIsClient();

  if (!isClient) return null;
  if (env.MODE === 'production') return null;

  return <DevTools position="bottom-right" store={customStore} theme={resolvedTheme === 'dark' ? 'dark' : 'light'} />;
}

// Add your navigation items here
const nav = [
  {
    items: [
      // { title: 'Home', url: '/', icon: HomeIcon },
      // { title: 'About', url: '/about', icon: InfoIcon },
      // { title: 'Posts', url: '/posts', icon: FileTextIcon },
      // { title: 'Changelog', url: '/changelog', icon: NotebookTextIcon },
    ],
    group: '',
  },
] satisfies NavContextType['nav'];

// designSystemId: set to 'atelier', 'workbench', or 'arena' based on the app's design system
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <AppProvider appContext={config} designSystemId="atelier">
      <ArkiAuthProvider authClient={authClient}>
        <NavContextProvider nav={nav}>
          <Provider store={customStore}>
            <TooltipProvider>
              <FullscreenProvider>
                <DevToolsWrapper />
                <DBProvider>{children}</DBProvider>
              </FullscreenProvider>
            </TooltipProvider>
          </Provider>
        </NavContextProvider>
      </ArkiAuthProvider>
    </AppProvider>
  );
}
