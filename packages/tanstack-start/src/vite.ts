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
