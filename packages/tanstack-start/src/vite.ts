import type { tanstackStart } from '@tanstack/react-start/plugin/vite';
import type { Plugin } from 'vite';

/**
 * Packages whose server-only subpaths are reached from the client module graph
 * **only** through TanStack Start `server.handlers` (which are stripped from the
 * client bundle), yet are eagerly followed by Vite's dev dep-scanner.
 *
 * `@arki/admin` publishes its `./server` subpath under `node`/`types` conditions
 * only (it reads secrets + `node:crypto`). It enters the graph via the
 * `GET /api/fleet` route handler that every Foreman-federated app mounts. The
 * dev dep-scanner crawls the route tree from `router.tsx`, follows the static
 * import into `@arki/admin/server`, and fails to resolve a `node`-only subpath
 * under browser conditions — aborting the scan ("Failed to run dependency
 * scan"). Excluding the package halts the crawl at the import boundary.
 */
const FLEET_SERVER_ONLY_PACKAGES = ['@arki/admin'] as const;

/**
 * Vite plugin for Foreman-federated TanStack Start apps.
 *
 * Excludes server-only packages reached through the `GET /api/fleet` handler
 * from the client dev dep-scan, so the scanner stops at the server-import
 * boundary instead of failing to resolve a `node`-only subpath under browser
 * conditions. No-op for the client/SSR bundles themselves — TanStack Start
 * already strips `server.handlers` from the client output.
 *
 * Add to a TanStack Start app's `plugins` whenever the app mounts the
 * `routes/api/fleet.ts` snapshot endpoint (i.e. it is part of the fleet).
 */
export function fleetVite(): Plugin {
  return {
    name: 'arki:tanstack-start:fleet',
    config() {
      return {
        optimizeDeps: {
          exclude: [...FLEET_SERVER_ONLY_PACKAGES],
        },
      };
    },
  };
}

type StartRouterOptions = NonNullable<NonNullable<Parameters<typeof tanstackStart>[0]>['router']>;

/**
 * One lazy chunk per route: the loader travels with the component.
 *
 * By default TanStack Router splits the component out of a route but keeps its
 * loader in the entry chunk, so the first page downloads every route's loader
 * imports: validators, server-function stubs, content. Grouping loader and
 * component keeps it one request per route and an entry chunk that holds the
 * router only. Pass as `tanstackStart({ router: { codeSplittingOptions: oneChunkPerRoute } })`.
 */
export const oneChunkPerRoute: NonNullable<StartRouterOptions['codeSplittingOptions']> = {
  defaultBehavior: [['loader', 'component'], ['pendingComponent'], ['errorComponent'], ['notFoundComponent']],
};

/** No newline: prepended on the entry's first line, so line numbers in stack traces and source maps hold. */
const ZOD_COMPILE_IMPORT = `import 'zod/compile';`;

/**
 * Compiled Zod on the server: every schema the server constructs parses
 * through a generated validator instead of the interpreter (Zod's own median
 * is 2.4x, more for wide objects). This covers oRPC input validation, server
 * function validators, env and every other `parse` on the server.
 *
 * Zod's `zod/compile` shim compiles the schemas constructed after it loads, so
 * it must be the first import of the server bundle. This plugin prepends that
 * import to every entry module of the server build (TanStack Start's own
 * server entry included), whether the app configures `server.entry` or not.
 * ES modules evaluate imports in order, so the shim installs before the route
 * tree, the Dot app and every other module construct a schema. The client is
 * untouched: the compiler is 7 KB and the browser runs no hot validation loop.
 * A schema the compiler cannot model (async refinements, transforms,
 * `z.coerce`, recursion) falls back to the interpreter with the same results.
 */
export function zodCompiled(): Plugin {
  return {
    name: 'arki:tanstack-start:zod-compiled',
    // Build only: the dev server's module info has no `isEntry` (reading it throws), and dev has no hot loop to speed up.
    apply: 'build',
    applyToEnvironment: environment => environment.config.consumer === 'server',
    transform(code, id) {
      // Rolldown resolves the build entries itself, so `resolveId` never sees them; the module info does.
      if (this.getModuleInfo(id)?.isEntry !== true) return;
      return { code: ZOD_COMPILE_IMPORT + code, map: null };
    },
  };
}
