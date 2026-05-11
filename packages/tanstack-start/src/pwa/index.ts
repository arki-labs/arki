/**
 * Configure `vite-plugin-pwa` for a TanStack Start app.
 *
 * - Uses the `injectManifest` strategy so apps can author custom service
 *   worker logic (push handlers, background sync, etc.) while still letting
 *   workbox compute the precache manifest.
 * - Sets `globDirectory: 'dist/client'` because TanStack Start + Nitro split
 *   the Vite output into `dist/client/` and `dist/server/`. The plugin's
 *   default (`dist/`) finds no JS/CSS and silently emits a 0KB precache.
 * - Sets `injectRegister: false`. TanStack Start renders no static
 *   `index.html`, so vite-plugin-pwa's auto-inject hook never runs.
 *   Register via {@link registerPwa} from `@arki/tanstack-start/pwa/client`
 *   inside `entry-client.tsx`.
 * - Defaults `manifest: false`. Most apps in this monorepo serve their own
 *   web app manifest (dynamic `/manifest.webmanifest` route or static file).
 *   Pass an explicit `manifest` if the plugin should generate one instead.
 */

import type { Plugin } from 'vite';
import type { ManifestOptions } from 'vite-plugin-pwa';
import { VitePWA } from 'vite-plugin-pwa';

type InjectManifestOverrides = {
  /**
   * Additional URLs to precache (e.g., the home route).
   */
  additionalManifestEntries?: Array<string | { url: string; revision: string | null }>;

  /**
   * Maximum size, in bytes, of a single file workbox will precache.
   * @default 3_000_000 (3 MB)
   */
  maximumFileSizeToCacheInBytes?: number;
};

export type CreatePwaPluginOptions = {
  /**
   * Web App Manifest. Pass `false` (default) to keep an app-owned manifest
   * as the single source of truth.
   */
  manifest?: Partial<ManifestOptions> | false;

  /**
   * Workbox precache glob patterns, resolved inside `dist/client`.
   * @default ['**\/*.{js,css,html,woff,woff2}']
   */
  globPatterns?: string[];

  /**
   * Source directory for the SW file, relative to project root.
   * @default 'src'
   */
  srcDir?: string;

  /**
   * SW filename inside `srcDir`.
   * @default 'service-worker.ts'
   */
  filename?: string;

  /**
   * Additional `injectManifest` overrides.
   */
  injectManifest?: InjectManifestOverrides;
};

export function createPwaPlugin(options: CreatePwaPluginOptions = {}): Plugin[] {
  const {
    manifest = false,
    globPatterns = ['**/*.{js,css,html,woff,woff2}'],
    srcDir = 'src',
    filename = 'service-worker.ts',
    injectManifest = {},
  } = options;

  return VitePWA({
    registerType: 'autoUpdate',
    injectRegister: false,
    strategies: 'injectManifest',
    srcDir,
    filename,
    manifest,
    injectManifest: {
      globDirectory: 'dist/client',
      globPatterns,
      ...injectManifest,
    },
  });
}
