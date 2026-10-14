/**
 * The DOT attachment: `foreman()` is a `defineFeature` slice that mounts the
 * protocol-2 routes under `/api/foreman`.
 *
 * ```ts
 * export const operations = defineFeature('operations', {
 *   needs: { kv: service<KV>(), db: service<Db>() },
 *   use: [
 *     foreman(({ kv, db }: { kv: KV; db: Db }) => ({
 *       env,
 *       environment: 'production',
 *       app: { version: pkg.version },
 *       nonces: kv,
 *       health: () => healthOf(db),
 *       modules: [queueModule(queue)],
 *       context: () => ({}),
 *     })),
 *   ],
 * });
 * ```
 *
 * The slice lands under the `routes` key, where `http({ features })` collects
 * it. `defineFeature` rejects two slices with one key, so put `foreman()` in
 * its own feature, not next to an `endpoints()` slice.
 *
 * `@arki/http` is an optional peer: this entry only makes sense in a DOT http app.
 */
import type { RouteBundle } from '@arki/http';
import { route, routes } from '@arki/http';

import type { ForemanAppOptions } from './foreman-app';
import { createForemanHandlerFromEnv } from './foreman-app';
import { FOREMAN_BASE_PATH } from './protocol';

// The dispatcher checks the signed path against the real request path, so these
// are contracts bound to the request (`ctx.req`) rather than a Hono prefix mount,
// which would strip `/api/foreman` before the handler sees the URL.
const manifestRoute = route.get(`${FOREMAN_BASE_PATH}/manifest`, {
  id: 'foreman.manifest',
  summary: 'Foreman manifest (signed)',
});
const readRoute = route.post(`${FOREMAN_BASE_PATH}/reads/:id`, {
  id: 'foreman.read',
  summary: 'Run one module read (signed)',
});
const previewRoute = route.post(`${FOREMAN_BASE_PATH}/actions/:id/preview`, {
  id: 'foreman.preview',
  summary: 'Preview one module action (signed)',
});
const executeRoute = route.post(`${FOREMAN_BASE_PATH}/actions/:id/execute`, {
  id: 'foreman.execute',
  summary: 'Execute one approved module action (signed, execute key)',
});

const ROUTE_CONTRACTS = [manifestRoute, readRoute, previewRoute, executeRoute] as const;

/**
 * The slice `foreman()` returns. Its shape is the `@arki/feature` slice
 * contract; this package does not import `@arki/feature`.
 */
export type ForemanFeatureSlice<TServices> = {
  readonly key: 'routes';
  readonly actions: readonly ReturnType<(typeof ROUTE_CONTRACTS)[number]['toDotAction']>[];
  readonly resolve: (services: TServices) => RouteBundle;
};

/**
 * Declare the Foreman routes of a DOT app. `build` runs once at boot with the
 * feature's `needs`. With no `FOREMAN_*` variables set the routes answer 404.
 */
export function foreman<TServices, TCtx>(
  build: (services: TServices) => ForemanAppOptions<TCtx>,
): ForemanFeatureSlice<TServices> {
  return {
    key: 'routes',
    actions: ROUTE_CONTRACTS.map(contract => contract.toDotAction()),
    resolve: services => {
      const handler = createForemanHandlerFromEnv(build(services));
      return routes()
        .bind(manifestRoute, (_input, ctx) => handler(ctx.req))
        .bind(readRoute, (_input, ctx) => handler(ctx.req))
        .bind(previewRoute, (_input, ctx) => handler(ctx.req))
        .bind(executeRoute, (_input, ctx) => handler(ctx.req));
    },
  };
}
