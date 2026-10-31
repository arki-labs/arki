/**
 * The modules every Foreman target serves (RFC § 3.3): `core.health`,
 * `core.manifest`, and `core.receipts` when the app has a receipt store. They are ordinary modules, so a DOT app and a plain
 * TanStack app expose them the same way.
 *
 * - `core.health` reports the roll-up status and the dependency checks, in the
 *   same shape as the v1 `/api/fleet` snapshot (`fleetHealthSchema`), so v1 and
 *   v2 cannot disagree.
 * - `core.manifest` returns the same manifest `GET /api/foreman/manifest` serves.
 */
import { z } from '@arki/contracts';

import type { FleetHealth } from './contract.ts';
import type { AnyForemanModule, ForemanModule } from './module.ts';
import type { ForemanEnvironment, ForemanManifest, ProviderReadiness, WritesMode } from './protocol.ts';
import type { ReceiptStore } from './receipts.ts';
import { fleetHealthCheckSchema, fleetHealthSchema } from './contract.ts';
import { defineModule, defineRead, describeModule } from './module.ts';
import { FOREMAN_PROTOCOL_VERSION, foremanManifestSchema } from './protocol.ts';
import { receiptsModule } from './receipts.ts';

export const CORE_PERMISSION = 'core:read';
export const CORE_HEALTH_MODULE_ID = 'core.health';
export const CORE_MANIFEST_MODULE_ID = 'core.manifest';
export const CORE_MODULE_VERSION = '1.0.0';

export type CoreModulesOptions<TCtx> = {
  /** This target: `id` and `environment` make up the audience (`shop:prod`). */
  app: { id: string; environment: ForemanEnvironment; version: string; commit?: string };
  /** Installed `@arki/*` versions. */
  packages?: Record<string, string>;
  /** `FOREMAN_WRITES`. */
  writes: WritesMode;
  providers?: Record<string, ProviderReadiness>;
  /** The app's health. Reuse the function behind `/api/fleet`: `async () => (await snapshot()).health`. */
  health: () => FleetHealth | Promise<FleetHealth>;
  /** The app's own modules. */
  modules?: readonly ForemanModule<TCtx>[];
  /** The receipt store the handler records executes in. Given, it is served as `core.receipts`. */
  receipts?: ReceiptStore;
};

const emptyInput = z.strictObject({});

/**
 * The module list to hand to `createForemanHandler`: `core.health`,
 * `core.manifest`, `core.receipts` (with a receipt store), then the app's own modules. The manifest read describes
 * this whole list, so it always agrees with `GET /api/foreman/manifest`.
 */
export function withCoreModules<TCtx>(options: CoreModulesOptions<TCtx>): readonly ForemanModule<TCtx>[] {
  const all: ForemanModule<TCtx>[] = [];

  const health = defineModule({
    id: CORE_HEALTH_MODULE_ID,
    version: CORE_MODULE_VERSION,
    reads: {
      status: defineRead({
        id: 'core.health.status',
        summary: 'Roll-up health of the app: ok, degraded or down',
        permission: CORE_PERMISSION,
        input: emptyInput,
        output: z.strictObject({ status: fleetHealthSchema.shape.status }),
        load: async () => {
          const { status } = await options.health();
          return { status };
        },
      }),
      checks: defineRead({
        id: 'core.health.checks',
        summary: 'Dependency checks behind the health status',
        permission: CORE_PERMISSION,
        input: emptyInput,
        output: z.array(fleetHealthCheckSchema),
        load: async () => {
          const { checks } = await options.health();
          return checks;
        },
      }),
    },
    actions: {},
  });

  const manifest = defineModule({
    id: CORE_MANIFEST_MODULE_ID,
    version: CORE_MODULE_VERSION,
    reads: {
      get: defineRead({
        id: 'core.manifest.get',
        summary: 'What this app reports about itself: identity, packages, modules and readiness',
        permission: CORE_PERMISSION,
        input: emptyInput,
        output: foremanManifestSchema,
        load: async (): Promise<ForemanManifest> => ({
          protocol: FOREMAN_PROTOCOL_VERSION,
          app: options.app,
          packages: options.packages ?? {},
          // Described lazily: `all` is complete by the time a request arrives.
          modules: await Promise.all(all.map((module: AnyForemanModule) => describeModule(module))),
          readiness: { writes: options.writes, providers: options.providers ?? {} },
        }),
      }),
    },
    actions: {},
  });

  all.push(health, manifest);
  if (options.receipts !== undefined) all.push(receiptsModule<TCtx>(options.receipts));
  all.push(...(options.modules ?? []));
  return all;
}
