/**
 * Configure `vite-plugin-pwa` for a TanStack Start app.
 *
 * - Uses the `injectManifest` strategy so apps can author custom service
 *   worker logic (push handlers, background sync, etc.) while still letting
 *   workbox compute the precache manifest.
 * - Sets `globDirectory: '.output/public'` because every TanStack Start app
 *   in this monorepo mounts Nitro in its Vite config, which emits the final
 *   client bundle to `.output/public/`. The plugin's default (`dist/`) and
 *   the legacy `dist/client/` find no JS/CSS and silently emit a 0KB
 *   precache — read `precache N entries` in the build log to verify.
 * - Sets `injectRegister: false`. TanStack Start renders no static
 *   `index.html`, so vite-plugin-pwa's auto-inject hook never runs.
 *   Register via {@link registerPwa} from `@arki/tanstack-start/pwa/client`
 *   inside `entry-client.tsx`.
 * - Defaults `manifest: false`. Most apps in this monorepo serve their own
 *   web app manifest (dynamic `/manifest.webmanifest` route or static file).
 *   Pass an explicit `manifest` if the plugin should generate one instead.
 * - Defaults `injectManifest.globIgnores` to {@link LAZY_CHUNK_IGNORES} —
 *   excludes shiki grammar/theme chunks and mermaid diagram chunks from
 *   the precache. These are dynamically imported per code-block language,
 *   theme, and diagram type, so precaching all 300+ wastes ~9 MB per
 *   install while almost no user ever needs more than a handful. Workbox
 *   falls through to the network on demand. Pass an explicit
 *   `injectManifest.globIgnores` to override (use `[]` to precache
 *   everything).
 * - Defaults `injectManifest.maximumFileSizeToCacheInBytes` to 4 MiB.
 *   Workbox's own default is 2 MiB, which vite-plugin-pwa treats as a
 *   build-blocking error rather than a warning — any single chunk over
 *   the limit fails `vite build`. 4 MiB covers real-world heavy entry
 *   chunks (ekuation main: ~2.5 MB) while still flagging genuine bloat.
 */

import type { Plugin } from 'vite';
import type { ManifestOptions } from 'vite-plugin-pwa';
import { VitePWA } from 'vite-plugin-pwa';

import { LAZY_CHUNK_IGNORES } from './lazy-ignores.js';

type InjectManifestOverrides = {
  /**
   * Additional URLs to precache (e.g., the home route).
   */
  additionalManifestEntries?: Array<string | { url: string; revision: string | null }>;

  /**
   * Maximum size, in bytes, of a single file workbox will precache.
   * Files larger than this fail the build (vite-plugin-pwa treats the
   * Workbox warning as fatal). Defaults to 4 MiB — enough headroom for
   * heavy entry chunks (e.g. ekuation's ~2.5 MB main bundle) while still
   * acting as a guardrail against accidentally precaching very large
   * assets. Bump higher if your app legitimately needs to precache files
   * over 4 MiB; consider code-splitting first.
   * @default 4_194_304 (4 MiB)
   */
  maximumFileSizeToCacheInBytes?: number;

  /**
   * Glob patterns (relative to `globDirectory`) of files to exclude from
   * the precache. Defaults to {@link LAZY_CHUNK_IGNORES} (shiki grammar
   * and theme chunks, mermaid diagram chunks). Pass an explicit value to
   * override — including `[]` to precache everything.
   *
   * To **add** patterns on top of the default, spread the constant:
   *
   * @example
   * ```ts
   * import { createPwaPlugin, LAZY_CHUNK_IGNORES } from '@arki/tanstack-start/pwa';
   *
   * createPwaPlugin({
   *   injectManifest: {
   *     globIgnores: [...LAZY_CHUNK_IGNORES, '**\/heavy-vendor-*.js'],
   *   },
   * });
   * ```
   */
  globIgnores?: string[];
};

export {
  LAZY_CHUNK_IGNORES,
  MERMAID_DIAGRAM_IGNORES,
  SHIKI_LANG_IGNORES,
  SHIKI_THEME_IGNORES,
} from './lazy-ignores.js';

export type CreatePwaPluginOptions = {
  /**
   * Web App Manifest. Pass `false` (default) to keep an app-owned manifest
   * as the single source of truth.
   */
  manifest?: Partial<ManifestOptions> | false;

  /**
   * Workbox precache glob patterns, resolved inside `.output/public`.
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

  const {
    globIgnores = [...LAZY_CHUNK_IGNORES],
    maximumFileSizeToCacheInBytes = 4 * 1024 * 1024,
    ...restInjectManifest
  } = injectManifest;

  return VitePWA({
    registerType: 'autoUpdate',
    injectRegister: false,
    strategies: 'injectManifest',
    srcDir,
    filename,
    manifest,
    injectManifest: {
      globDirectory: '.output/public',
      globPatterns,
      globIgnores,
      maximumFileSizeToCacheInBytes,
      ...restInjectManifest,
    },
  });
}
