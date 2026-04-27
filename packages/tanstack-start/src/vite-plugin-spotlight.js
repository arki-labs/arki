/**
 * Vite plugin that wires up Spotlight (Sentry's local-dev error overlay)
 * for TanStack Start apps.
 *
 * Two things happen on `vite serve` (dev only):
 *
 *   1. The Spotlight sidecar (a Hono SSE relay process) is started in-process,
 *      listening on `port` (default 8969). It receives Sentry-format envelopes
 *      from the browser and broadcasts them to any connected overlay UI.
 *
 *   2. `import.meta.env.VITE_ARKI_SPOTLIGHT_URL` is injected with the
 *      sidecar's stream URL. The browser-side `<DevTools />` reads this var
 *      and lazy-mounts `@spotlightjs/overlay` against it. Apps that don't
 *      include this plugin leave the env var undefined, so the overlay
 *      branch is dead-code-eliminated and the rest of devtools still work.
 *
 * Authored as plain ESM `.js` (not `.ts`) on purpose: Vite's config loader
 * runs in Node *before* Vite is bootstrapped, so it cannot resolve `.ts`
 * source files coming from a workspace package. Types are expressed via
 * JSDoc and the companion `.d.ts` so consumers still get full IntelliSense.
 *
 * Usage in `vite.config.ts`:
 * ```ts
 * import { spotlight } from '@arki/tanstack-start/vite-plugin-spotlight';
 *
 * export default defineConfig({
 *   plugins: [
 *     spotlight(),
 *     // ... other plugins
 *   ],
 * });
 * ```
 */

const PLUGIN_NAME = '@arki/tanstack-start:spotlight';

/**
 * @typedef {object} SpotlightVitePluginOptions
 * @property {number} [port=8969]   Port the sidecar listens on. Spotlight mounts
 *                                   its routes at the root of this port — there's
 *                                   no HTTP base path.
 * @property {boolean} [log=false]  Print sidecar lifecycle logs to the terminal.
 */

/**
 * Returns a Vite plugin that starts the Spotlight sidecar in dev mode and
 * exposes its stream URL to the browser via `import.meta.env`.
 *
 * @param {SpotlightVitePluginOptions} [options]
 * @returns {import('vite').Plugin}
 */
export function spotlight(options = {}) {
  const { port = 8969, log = false } = options;
  const sidecarUrl = `http://localhost:${port}/stream`;
  let started = false;

  return {
    name: PLUGIN_NAME,
    apply: 'serve',
    enforce: 'pre',
    config() {
      return {
        define: {
          'import.meta.env.VITE_ARKI_SPOTLIGHT_URL': JSON.stringify(sidecarUrl),
        },
      };
    },
    async configureServer(server) {
      if (started) return;
      started = true;
      try {
        const { setupSpotlight } = await import('@spotlightjs/spotlight');
        const silentLogger = {
          info: () => {},
          warn: () => {},
          error: () => {},
          debug: () => {},
        };
        await setupSpotlight({
          port,
          isStandalone: true,
          logger: log ? undefined : silentLogger,
        });
        if (log) {
          server.config.logger.info(
            `[${PLUGIN_NAME}] sidecar listening on ${sidecarUrl}`,
          );
        }
      } catch (error) {
        server.config.logger.warn(
          `[${PLUGIN_NAME}] sidecar failed to start: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}

export default spotlight;
