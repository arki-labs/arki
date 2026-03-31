/**
 * TanStack Start App Configuration
 *
 * This module provides a unified configuration interface for TanStack Start apps,
 * similar to next.config.ts for Next.js applications.
 */

import { defineConfig } from '@tanstack/react-start/config';

export interface AppConfig {
  /**
   * Base path for the application
   */
  basePath?: string;

  /**
   * Enable React strict mode
   * @default true
   */
  reactStrictMode?: boolean;

  /**
   * Server preset for Nitro
   * @default 'bun'
   */
  serverPreset?: 'bun' | 'node-server' | 'vercel' | 'cloudflare-pages' | 'netlify';

  /**
   * Vite plugins to add
   */
  vitePlugins?: unknown[];

  /**
   * Environment variables to expose to the client
   */
  clientEnvPrefix?: string;

  /**
   * Enable SSR
   * @default true
   */
  ssr?: boolean;

  /**
   * Custom Vite configuration overrides
   */
  vite?: Record<string, unknown>;
}

/**
 * Creates a TanStack Start app configuration with sensible defaults
 *
 * @example
 * ```ts
 * // app.config.ts
 * import { createAppConfig } from '@arki/tanstack-start/config';
 *
 * export default createAppConfig({
 *   serverPreset: 'bun',
 *   reactStrictMode: true,
 * });
 * ```
 */
export function createAppConfig(config: AppConfig = {}) {
  const {
    basePath,
    reactStrictMode = true,
    serverPreset = 'bun',
    vitePlugins = [],
    clientEnvPrefix = 'VITE_',
    ssr = true,
    vite = {},
  } = config;

  return defineConfig({
    server: {
      preset: serverPreset,
      // Bun-specific optimizations
      ...(serverPreset === 'bun' && {
        compatibilityDate: '2024-12-01',
      }),
    },
    vite: {
      resolve: { tsconfigPaths: true },
      plugins: [...vitePlugins],
      envPrefix: clientEnvPrefix,
      build: {
        // Enable source maps for production debugging
        sourcemap: 'hidden',
      },
      // React strict mode
      ...(reactStrictMode && {
        define: {
          'import.meta.env.REACT_STRICT_MODE': JSON.stringify(true),
        },
      }),
      ...vite,
    },
    react: {
      babel: {
        plugins: [
          // Add common babel plugins if needed
        ],
      },
    },
    routers: {
      ssr: {
        entry: './src/entry-server.tsx',
      },
      client: {
        entry: './src/entry-client.tsx',
      },
    },
    tsr: {
      appDirectory: './src',
      routesDirectory: './src/routes',
      generatedRouteTree: './src/routeTree.gen.ts',
      quoteStyle: 'single',
      semicolons: true,
      routeFileIgnorePattern: '.*.css',
    },
  });
}

export { defineConfig };
