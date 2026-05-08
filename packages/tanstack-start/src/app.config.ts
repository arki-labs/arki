/**
 * TanStack Start App Configuration
 *
 * Convenience builder that returns a Vite `UserConfig` pre-wired with the
 * TanStack Start plugin and React plugin. Apps can spread the result into
 * their own `vite.config.ts` or use it directly. Mirrors the role
 * `app.config.ts` played in earlier TanStack Start versions before the
 * project moved fully onto Vite.
 */

import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import type { PluginOption, UserConfig } from 'vite';
import { defineConfig } from 'vite';

type TanStackStartOptions = Parameters<typeof tanstackStart>[0];

export interface AppConfig {
  /** Base path for the application (becomes Vite's `base`). */
  basePath?: string;

  /**
   * Enable React strict-mode hint via `import.meta.env.REACT_STRICT_MODE`.
   * @default true
   */
  reactStrictMode?: boolean;

  /** Extra Vite plugins to add alongside the TanStack Start + React plugins. */
  vitePlugins?: PluginOption[];

  /**
   * Environment variable prefix exposed to the client.
   * @default 'VITE_'
   */
  clientEnvPrefix?: string;

  /** Options forwarded to `tanstackStart()`. */
  tanstackStart?: TanStackStartOptions;

  /** Custom Vite configuration overrides merged on top of the defaults. */
  vite?: Partial<UserConfig>;
}

/**
 * Creates a TanStack Start Vite configuration with sensible defaults.
 *
 * @example
 * ```ts
 * // vite.config.ts
 * import { createAppConfig } from '@arki/tanstack-start/config';
 *
 * export default createAppConfig({
 *   reactStrictMode: true,
 *   tanstackStart: { server: { entry: './entry-server.ts' } },
 * });
 * ```
 */
export function createAppConfig(config: AppConfig = {}): UserConfig {
  const {
    basePath,
    reactStrictMode = true,
    vitePlugins = [],
    clientEnvPrefix = 'VITE_',
    tanstackStart: tanstackStartOptions,
    vite = {},
  } = config;

  return defineConfig({
    base: basePath,
    envPrefix: clientEnvPrefix,
    resolve: {
      tsconfigPaths: true,
      ...vite.resolve,
    },
    build: {
      sourcemap: 'hidden',
      ...vite.build,
    },
    define: reactStrictMode
      ? {
          'import.meta.env.REACT_STRICT_MODE': JSON.stringify(true),
          ...vite.define,
        }
      : vite.define,
    plugins: [...vitePlugins, tanstackStart(tanstackStartOptions), viteReact(), ...(vite.plugins ?? [])],
    ...vite,
  });
}

export { defineConfig };
