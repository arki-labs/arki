/**
 * Devtools implementation — split into a separate module so the public
 * `DevTools` entry point can lazy-load it. Vite's tree-shaker strips this
 * file from production bundles because the `lazy()` import is gated by
 * `import.meta.env.DEV`.
 *
 * Mounts the unified `<TanStackDevtools>` host with Router + React Query
 * panels as tabs. A single floating button in the corner opens both.
 *
 * Spotlight (Sentry's local-dev error overlay) is intentionally NOT wired
 * here. Spotlight v4 split into a Node sidecar (`@spotlightjs/spotlight`)
 * plus a browser overlay (`@spotlightjs/overlay`) that requires the
 * sidecar process to be running and a Sentry browser SDK capturing events.
 * That's a heavier integration that warrants its own PR.
 */
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

export function DevToolsImpl({ position = 'bottom-right' }: DevToolsProps) {
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
