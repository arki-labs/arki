/**
 * The one mount every app uses for `/api/foreman/*`. It wraps
 * `createForemanHandlerFromEnv` with the three things each app used to write
 * by hand:
 *
 *  1. the handler is built on the first request, never at import;
 *  2. one store holds both the nonces and the receipts, and the receipts are
 *     namespaced by the app's own audience (`FOREMAN_APP_ID:environment`);
 *  3. with no store, the route answers 404 while the keys are unset, and throws
 *     once they are set: signed requests without replay protection are refused.
 *
 * ```ts
 * // a plain app: one handler for the process
 * export const foremanRoute = createForemanRoute(() => ({
 *   env, app: { version }, store: kv, context: () => ({}),
 *   health: async () => (await getFleetSnapshot()).health,
 * }));
 * // start/src/routes/api/foreman/$.ts
 * ANY: ({ request }) => foremanRoute(request)
 *
 * // a DOT app: one handler per app graph
 * export const foremanRoute = createForemanRoute((services: Services) => ({ ... }));
 * ANY: ({ request, context }) => foremanRoute(request, context.services)
 * ```
 */
import type { NonceStore } from './dispatcher';
import type { ForemanEnv } from './env';
import type { ForemanAppOptions } from './foreman-app';
import type { ForemanEnvironment } from './protocol';
import type { ReceiptKV, StoredReceipt } from './receipts';
import { foremanConfigFromEnv, foremanEnvironmentFromNodeEnv } from './env';
import { ADMIN_ERROR_CODES, AdminError } from './errors';
import { createForemanHandlerFromEnv, foremanOff } from './foreman-app';
import { kvReceiptStore } from './receipts';

type ForemanHandler = (request: Request) => Promise<Response>;

/**
 * Where the nonces and the receipts live. An `@arki/kv` `KV` fits, and so do
 * `pgForemanStore` (`@arki/admin/pg`) and {@link memoryForemanStore}.
 * `setIfNotExists` must be atomic across app instances.
 */
export type ForemanStore = NonceStore & ReceiptKV;

export type ForemanRouteOptions<TCtx> = Omit<ForemanAppOptions<TCtx>, 'nonces' | 'receipts' | 'environment'> & {
  /** The app's validated env: the `FOREMAN_*` keys, and `NODE_ENV` to derive the environment. */
  env: ForemanEnv & { readonly NODE_ENV?: string };
  /**
   * The nonces and receipts. `null` when the app has none in this process (development without a KV):
   * the route then answers 404 while the keys are unset, and throws `ARKI_ADMIN_E014` once they are set.
   */
  store: ForemanStore | null;
  /** Defaults to `foremanEnvironmentFromNodeEnv(env.NODE_ENV, env.FOREMAN_ENVIRONMENT)`. */
  environment?: ForemanEnvironment;
};

/**
 * Build the `/api/foreman/*` handler of an app. `build` runs on the first request; with a services
 * object (a DOT app graph) it runs once per object, so two graphs in one process (tests) never share a handler.
 */
export function createForemanRoute<TServices = void, TCtx = Record<string, never>>(
  build: (services: TServices) => ForemanRouteOptions<TCtx>,
): (request: Request, services: TServices) => Promise<Response> {
  const perServices = new WeakMap<object, ForemanHandler>();
  let single: ForemanHandler | undefined;
  return (request, services) => {
    if (typeof services === 'object' && services !== null) {
      let handler = perServices.get(services);
      if (handler === undefined) {
        handler = handlerFrom(build(services));
        perServices.set(services, handler);
      }
      return handler(request);
    }
    single ??= handlerFrom(build(services));
    return single(request);
  };
}

function handlerFrom<TCtx>(options: ForemanRouteOptions<TCtx>): ForemanHandler {
  const { store, environment: chosen, ...rest } = options;
  const environment = chosen ?? foremanEnvironmentFromNodeEnv(options.env.NODE_ENV, options.env.FOREMAN_ENVIRONMENT);
  const config = foremanConfigFromEnv(options.env, environment);
  if (config === undefined) return foremanOff();
  if (store === null) {
    throw new AdminError(
      ADMIN_ERROR_CODES.invalidConfig,
      'The FOREMAN_* keys are set but the app passed no store: signed requests need one for replay protection.',
      'Pass a KV, pgForemanStore from @arki/admin/pg, or memoryForemanStore for a single-instance app.',
    );
  }
  return createForemanHandlerFromEnv({
    ...rest,
    environment,
    nonces: store,
    // The namespace is the audience, so apps sharing one store never read each other's receipts.
    receipts: kvReceiptStore(store, { namespace: `${config.appId}:${environment}` }),
  });
}

type MemoryEntry = { readonly value: unknown; readonly expiresAt: number };

/**
 * A store in this process's memory, for an app that runs one instance and has no KV or database.
 * A restart forgets every nonce, so a request captured before it can be replayed until its signature
 * expires (the dispatcher's clock-skew window, minutes). Keep `FOREMAN_WRITES` off with it.
 */
export function memoryForemanStore(now: () => number = Date.now): ForemanStore {
  const entries = new Map<string, MemoryEntry>();
  const live = (key: string): MemoryEntry | undefined => {
    const entry = entries.get(key);
    if (entry !== undefined && entry.expiresAt <= now()) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  };
  const sweep = () => {
    const at = now();
    for (const [key, entry] of entries) if (entry.expiresAt <= at) entries.delete(key);
  };
  const forever = Number.POSITIVE_INFINITY;
  return {
    get: key => Promise.resolve(live(key)?.value),
    set: (key: string, value: StoredReceipt, expirationSeconds?: number) => {
      const expiresAt = expirationSeconds === undefined ? forever : now() + expirationSeconds * 1000;
      entries.set(key, { value: structuredClone(value), expiresAt });
      return Promise.resolve(true);
    },
    setIfNotExists: (key, value, expirationSeconds) => {
      sweep();
      if (live(key) !== undefined) return Promise.resolve(false);
      entries.set(key, { value, expiresAt: now() + expirationSeconds * 1000 });
      return Promise.resolve(true);
    },
  };
}
