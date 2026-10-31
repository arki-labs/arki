/**
 * Devtools implementation — split into a separate module so the public
 * `DevTools` entry point can lazy-load it. Vite's tree-shaker strips this
 * file from production bundles because the `lazy()` import is gated by
 * `import.meta.env.DEV`.
 *
 * Default panels (always present):
 *   1. Environment — locale, mode, Sentry status, build info, quick actions.
 *   2. TanStack Router — route tree + match state.
 *   3. TanStack Query — cache + mutation state.
 *
 * Optional panels (mounted only when the corresponding prop is provided):
 *   4. Jotai — when `jotaiStore` is passed. Embeds `jotai-devtools`'s
 *      `<DevTools />` as a tab and suppresses its own floating trigger,
 *      so apps no longer need to mount jotai-devtools separately.
 */
import type { TanStackDevtoolsReactPlugin } from '@tanstack/react-devtools';
import { TanStackDevtools } from '@tanstack/react-devtools';
import { ReactQueryDevtoolsPanel } from '@tanstack/react-query-devtools';
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools';

import type { DevToolsProps } from './devtools.js';
import { EnvironmentPanel } from './devtools-environment.js';
import { JotaiPanel } from './devtools-jotai.js';

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
  jotaiStore,
}: DevToolsProps) {
  const plugins: TanStackDevtoolsReactPlugin[] = [
    ENVIRONMENT_PLUGIN,
    ROUTER_PLUGIN,
    QUERY_PLUGIN,
  ];

  if (jotaiStore) {
    plugins.push({
      name: 'Jotai',
      render: <JotaiPanel store={jotaiStore} />,
    });
  }

  return (
    <TanStackDevtools
      plugins={plugins}
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
