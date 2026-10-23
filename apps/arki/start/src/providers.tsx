import type { NavContextType } from '@fleet/sitekit/nav-context.tsx';
import { lazy, Suspense } from 'react';
import { FullscreenProvider } from '@fleet/react-fullscreen';
import { NavContextProvider } from '@fleet/sitekit/nav-context.tsx';
import { createStore, Provider } from 'jotai';
import { NuqsAdapter } from 'nuqs/adapters/tanstack-router';

import { ArkiAuthProvider } from '@arki/auth/tanstack-start';
import { clearCachesOnUserChange } from '@arki/tanstack-start/pwa/client';
import { useIsClient } from '@arki/ui/hooks/is-client';
import { Toaster } from '@arki/ui/sonner';
import { useTheme } from '@arki/ui/theme';
import { TooltipProvider } from '@arki/ui/tooltip';

import { authClient } from './features/auth/client';
import { DBProvider } from './lib/db/provider';
import { ORPCReactProvider } from './lib/orpc/client';
import { LocaleProvider } from './shared/locale-provider';

const customStore = createStore();

// `import.meta.env.MODE` is replaced by a literal at build time, so production builds drop
// jotai-devtools (and the Mantine copy it bundles) entirely.
const DevTools =
  import.meta.env.MODE === 'production'
    ? null
    : lazy(() => import('jotai-devtools').then(module => ({ default: module.DevTools })));

function DevToolsWrapper() {
  const { resolvedTheme } = useTheme();
  const isClient = useIsClient();

  if (!isClient || !DevTools) return null;

  return (
    <Suspense fallback={null}>
      <DevTools position="bottom-right" store={customStore} theme={resolvedTheme === 'dark' ? 'dark' : 'light'} />
    </Suspense>
  );
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

/**
 * Providers only signed-in pages need: auth, the oRPC query client, translations, the workspace nav, toasts and tooltips. Mounted
 * by the signed-in layouts (`_app`, `auth/$pathname`), not by `__root`, so public pages (docs, packages, errors,
 * marketing) do not download them.
 */
export function SignedInProviders({ children }: { children: React.ReactNode }) {
  return (
    <LocaleProvider>
      <ORPCReactProvider>
        <NuqsAdapter>
          <ArkiAuthProvider
            authClient={authClient}
            capabilities={authClient.capabilities}
            onUserChange={clearCachesOnUserChange}
          >
            <NavContextProvider nav={nav}>
              <Provider store={customStore}>
                <TooltipProvider>
                  <FullscreenProvider>
                    <DevToolsWrapper />
                    <DBProvider>{children}</DBProvider>
                    <Toaster />
                  </FullscreenProvider>
                </TooltipProvider>
              </Provider>
            </NavContextProvider>
          </ArkiAuthProvider>
        </NuqsAdapter>
      </ORPCReactProvider>
    </LocaleProvider>
  );
}
