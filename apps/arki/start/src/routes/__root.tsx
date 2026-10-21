import type { ReactNode } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { createRootRouteWithContext, HeadContent, Link, Outlet, ScriptOnce, Scripts } from '@tanstack/react-router';

import { DevTools } from '@fleet/sitekit/devtools';
import { arkiThemeClasses, arkiThemes } from '@arki/design-systems/arki/themes';
import { THEME_STORAGE_KEY, themeDetectionFn } from '@arki/theme/script';

import { getLocale } from '../paraglide/runtime.js';
import { RootProvider } from '../root-provider';
import appCss from '../styles/global.css?url';

function FunctionOnce<T = unknown>({
  children,
  param,
}: {
  children: (param: T) => unknown;
  param?: T;
}) {
  return <ScriptOnce>{`(${children.toString()})(${JSON.stringify(param)})`}</ScriptOnce>;
}

function DefaultNotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4">
      <h1 className="text-4xl font-bold">404</h1>
      <p className="text-muted-foreground">Page not found</p>
      <Link to="/" className="text-primary hover:underline">
        Go home
      </Link>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: 'utf8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { name: 'theme-color', content: '#FFFFFF', media: '(prefers-color-scheme: light)' },
      { name: 'theme-color', content: '#000000', media: '(prefers-color-scheme: dark)' },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', href: '/favicon.ico', sizes: '48x48' },
      { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
      { rel: 'icon', href: '/favicon-16.png', sizes: '16x16', type: 'image/png' },
      { rel: 'icon', href: '/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { rel: 'icon', href: '/favicon-48.png', sizes: '48x48', type: 'image/png' },
      { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
      { rel: 'manifest', href: '/site.webmanifest' },
    ],
  }),
  component: RootComponent,
  notFoundComponent: DefaultNotFound,
});

function RootComponent() {
  const lang = getLocale();

  return (
    <RootDocument lang={lang}>
      <RootProvider>
        <Outlet />
      </RootProvider>
    </RootDocument>
  );
}

function RootDocument({ lang, children }: { lang: string; children: ReactNode }) {
  return (
    <html suppressHydrationWarning lang={lang}>
      <head>
        <HeadContent />
        {/* Same themes and classes as ThemeProvider in root-provider.tsx, so the first paint matches hydration. */}
        <FunctionOnce param={{ storageKey: THEME_STORAGE_KEY, themes: arkiThemes, themeClasses: arkiThemeClasses }}>
          {themeDetectionFn}
        </FunctionOnce>
      </head>
      <body className="h-dvh overflow-hidden bg-background font-sans text-foreground antialiased">
        {children}
        <Scripts />
        <DevTools />
      </body>
    </html>
  );
}
