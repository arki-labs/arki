/**
 * `@arki/http` bundle adapter for the fleet endpoint — the declare-once
 * and bind-once halves of `GET /api/fleet`, so a DOT app's fleet plugin is
 * a three-liner instead of hand-wiring `createFleetHandler` into a
 * route binding.
 *
 * `@arki/http` is an OPTIONAL peer (same pattern as the `/dot`
 * adapters): importing this module without it installed fails at module
 * load — intentional, it only makes sense in a DOT http app. The plain
 * `createFleetHandler` in `./server` remains the framework-agnostic
 * path (TanStack Start routes etc.).
 */
import type { RouteBundle } from '@arki/http';
import { raw, route, routes } from '@arki/http';

import type { CreateFleetHandlerOptions } from './server.ts';
import { FLEET_ENDPOINT_PATH, fleetSnapshotSchema } from './contract.ts';
import { createFleetHandler } from './server.ts';

/**
 * The STATIC half — list this in the fleet plugin's `actions:` so the
 * endpoint attributes to the feature in `dot explain`. The handler owns
 * its 401/502 error formats and returns a raw `Response`, so the route is
 * `raw()`; `responses` documents the payload and enforces nothing.
 */
export const fleetSnapshotRoute = route.get(FLEET_ENDPOINT_PATH, {
  id: 'fleet.snapshot',
  summary: 'Foreman fleet snapshot (token-gated)',
  output: raw({ contentType: 'application/json' }),
  responses: { 200: fleetSnapshotSchema },
});

/**
 * The BOOT half — a ready-to-provide bundle around the shared
 * token-gated handler. Call where the snapshot's dependencies exist:
 *
 * ```ts
 * boot: ({ db }) =>
 *   provide(FleetRoutes, fleetRoutes({
 *     token: env.FOREMAN_TOKEN,
 *     snapshot: () => getFleetSnapshot(db),
 *   })),
 * ```
 */
export function fleetRoutes(options: CreateFleetHandlerOptions): RouteBundle {
  const handler = createFleetHandler(options);
  return routes().bind(fleetSnapshotRoute, (_input, ctx) => handler(ctx.req));
}
