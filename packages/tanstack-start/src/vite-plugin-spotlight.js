/**
 * Vite plugin that wires up Spotlight (Sentry's local-dev error overlay)
 * for TanStack Start apps.
 *
 * Two things happen on `vite serve` (dev only):
 *
 *   1. The Spotlight sidecar (a Hono SSE relay process) is spawned as a
 *      CHILD PROCESS, listening on `port` (default 8969). Spawning rather
 *      than `import()`-ing it is critical: `@spotlightjs/spotlight` pulls
 *      in `@sentry/node`, whose OpenTelemetry auto-instrumentation patches
 *      Node's built-in `http` module on import. That patching corrupts
 *      Vite's dev-server response pipeline — every SSR response becomes
 *      `[object Response]` (the literal stringification of a Response
 *      object). Running the sidecar in its own Node process keeps Vite's
 *      process module graph clean.
 *
 *   2. `import.meta.env.VITE_ARKI_SPOTLIGHT_URL` is injected with the
 *      sidecar's stream URL. The browser-side `<DevTools />` reads this
 *      var and lazy-mounts `@spotlightjs/overlay` against it. Apps that
 *      don't include this plugin leave the env var undefined, so the
 *      overlay branch is dead-code-eliminated and the rest of devtools
 *      still work.
 *
 * Authored as plain ESM `.js` (not `.ts`) on purpose: Vite's config loader
 * runs in Node *before* Vite is bootstrapped and cannot resolve `.ts`
 * source files coming from a workspace package. Types are expressed via
 * JSDoc and the companion `.d.ts`.
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
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_NAME = '@arki/tanstack-start:spotlight';

/**
 * @typedef {object} SpotlightVitePluginOptions
 * @property {number} [port=8969]   Port the sidecar listens on. Spotlight mounts
 *                                   its routes at the root of this port — there's
 *                                   no HTTP base path.
 * @property {boolean} [log=false]  Forward sidecar stdout/stderr to the terminal.
 */

/**
 * Returns a Vite plugin that spawns the Spotlight sidecar as a child process
 * in dev mode and exposes its stream URL to the browser via `import.meta.env`.
 *
 * @param {SpotlightVitePluginOptions} [options]
 * @returns {import('vite').Plugin}
 */
export function spotlight(options = {}) {
  const { port = 8969, log = false } = options;
  const sidecarUrl = `http://localhost:${port}/stream`;
  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null;

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
      if (child) return;

      let binPath;
      try {
        // `@spotlightjs/spotlight` ships `import`-only exports and doesn't
        // expose `./package.json`. `import.meta.resolve()` (sync since Node 20)
        // honors the `import` condition; we then walk up from the main entry
        // to the package root and read `bin.spotlight` from package.json.
        const mainUrl = import.meta.resolve('@spotlightjs/spotlight');
        const mainPath = fileURLToPath(mainUrl);
        let pkgRoot = dirname(mainPath);
        while (pkgRoot !== dirname(pkgRoot) && !existsSync(join(pkgRoot, 'package.json'))) {
          pkgRoot = dirname(pkgRoot);
        }
        if (!existsSync(join(pkgRoot, 'package.json'))) {
          throw new Error(`could not find package.json walking up from ${mainPath}`);
        }
        const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
        const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.spotlight;
        if (!binRel) {
          throw new Error('no `bin.spotlight` field in @spotlightjs/spotlight package.json');
        }
        binPath = join(pkgRoot, binRel);
      } catch (error) {
        server.config.logger.warn(
          `[${PLUGIN_NAME}] could not locate sidecar binary: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }

      child = spawn(process.execPath, [binPath, String(port)], {
        stdio: log ? 'inherit' : 'ignore',
        // Detach so the parent vite process doesn't leak stdio descriptors,
        // but we still kill the child explicitly on shutdown.
        detached: false,
        env: { ...process.env, NODE_ENV: 'development' },
      });

      child.on('exit', (code, signal) => {
        if (log && code !== 0) {
          server.config.logger.warn(
            `[${PLUGIN_NAME}] sidecar exited (code=${code}, signal=${signal})`,
          );
        }
        child = null;
      });

      const cleanup = () => {
        if (child && !child.killed) {
          child.kill('SIGTERM');
          child = null;
        }
      };
      server.httpServer?.once('close', cleanup);
      process.once('exit', cleanup);
      process.once('SIGINT', cleanup);
      process.once('SIGTERM', cleanup);

      if (log) {
        server.config.logger.info(`[${PLUGIN_NAME}] sidecar spawned on ${sidecarUrl}`);
      }
    },
  };
}

export default spotlight;
