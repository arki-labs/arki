/**
 * Devtools implementation — split into a separate module so the public
 * `DevTools` entry point can lazy-load it. Vite's tree-shaker strips this
 * file from production bundles because the `lazy()` import is gated by
 * `import.meta.env.DEV`.
 *
 * Three panels ship by default:
 *   1. Environment — locale, mode, Sentry status, build info, quick actions.
 *   2. TanStack Router — route tree + match state.
 *   3. TanStack Query — cache + mutation state.
 */
import { TanStackDevtools, type TanStackDevtoolsReactPlugin } from '@tanstack/react-devtools';
import { ReactQueryDevtoolsPanel } from '@tanstack/react-query-devtools';
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools';

import type { DevToolsProps } from './devtools';
import { EnvironmentPanel } from './devtools-environment';

const ENVIRONMENT_PLUGIN: TanStackDevtoolsReactPlugin = {
  name: 'Environment',
  render: <EnvironmentPanel />,
};

const ROUTER_PLUGIN: TanStackDevtoolsReactPlugin = {
  name: 'TanStack Router',
  render: <TanStackRouterDevtoolsPanel />,
};

const QUERY_PLUGIN: TanStackDevtoolsReactPlugin = {
  name: 'TanStack Query',
  render: <ReactQueryDevtoolsPanel />,
};

export function DevToolsImpl({
  position = 'bottom-right',
  hideUntilHover = true,
  defaultOpen = false,
  openHotkey = ['Shift', 'Alt', 'D'],
  panelLocation = 'bottom',
}: DevToolsProps) {
  return (
    <TanStackDevtools
      plugins={[ENVIRONMENT_PLUGIN, ROUTER_PLUGIN, QUERY_PLUGIN]}
      config={{
        position,
        hideUntilHover,
        defaultOpen,
        openHotkey,
        panelLocation,
      }}
    />
  );
}
