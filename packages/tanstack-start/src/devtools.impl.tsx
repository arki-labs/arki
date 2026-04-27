/**
 * Devtools implementation — split into a separate module so the public
 * `DevTools` entry point can lazy-load it. Vite's tree-shaker strips this
 * file from production bundles because the `lazy()` import is gated by
 * `import.meta.env.DEV`.
 *
 * Mounts the unified `<TanStackDevtools>` host with Router + React Query
 * panels as tabs. A single floating button in the corner opens both.
 *
 * Spotlight (Sentry's local-dev error overlay) mounts as a separate
 * floating overlay when the app's `vite.config.ts` includes
 * `@arki/tanstack-start/vite-plugin-spotlight`. The plugin sets
 * `import.meta.env.VITE_ARKI_SPOTLIGHT_URL`; we read it at runtime and
 * lazy-load `@spotlightjs/overlay` when present. Apps that don't add the
 * Vite plugin leave the env var undefined and the spotlight branch is
 * dead-code-eliminated.
 */
import { useEffect } from 'react';
import { TanStackDevtools, type TanStackDevtoolsReactPlugin } from '@tanstack/react-devtools';
import { ReactQueryDevtoolsPanel } from '@tanstack/react-query-devtools';
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools';

import type { DevToolsProps } from './devtools';

const ROUTER_PLUGIN: TanStackDevtoolsReactPlugin = {
  name: 'TanStack Router',
  render: <TanStackRouterDevtoolsPanel />,
};

const QUERY_PLUGIN: TanStackDevtoolsReactPlugin = {
  name: 'TanStack Query',
  render: <ReactQueryDevtoolsPanel />,
};

const SPOTLIGHT_URL = import.meta.env.VITE_ARKI_SPOTLIGHT_URL as string | undefined;

export function DevToolsImpl({ position = 'bottom-right' }: DevToolsProps) {
  useEffect(() => {
    if (!SPOTLIGHT_URL) return;
    let cancelled = false;
    void import('@spotlightjs/overlay')
      .then(async (mod) => {
        if (cancelled) return;
        await mod._init({ sidecarUrl: SPOTLIGHT_URL });
      })
      .catch((error) => {
        console.warn('[arki:devtools] Spotlight overlay failed to mount:', error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <TanStackDevtools
      plugins={[ROUTER_PLUGIN, QUERY_PLUGIN]}
      config={{
        position,
        defaultOpen: false,
      }}
    />
  );
}
