import type { Plugin } from 'vite';

export type SpotlightVitePluginOptions = {
  /** Port the sidecar listens on. Spotlight mounts its routes at the root
   * of this port — there is no HTTP base path. @default 8969 */
  port?: number;
  /** Print sidecar lifecycle logs to the terminal. @default false */
  log?: boolean;
};

/**
 * Returns a Vite plugin that starts the Spotlight sidecar in dev mode and
 * exposes its stream URL to the browser via `import.meta.env.VITE_ARKI_SPOTLIGHT_URL`.
 */
export function spotlight(options?: SpotlightVitePluginOptions): Plugin;
export default spotlight;
