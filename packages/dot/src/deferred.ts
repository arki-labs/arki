/** `Deferred<T>` and `resolveDeferred`: adapter options given now or as a thunk the adapter calls at boot. */

/**
 * A value or a zero-arg thunk producing it — the deferred-config shape DOT
 * adapters accept so a declaration can reference env without observing it
 * at module load: `kv(() => ({ url: env.REDIS_URL }))`. The adapter calls
 * {@link resolveDeferred} at boot, which is where the observation belongs.
 *
 * Not for function-typed `T` — a thunk would be indistinguishable from the
 * value itself.
 */
export type Deferred<T> = T | (() => T);

/** Resolve a {@link Deferred}: call it if it is a thunk, return it otherwise. */
export function resolveDeferred<T>(value: Deferred<T>): T {
  return typeof value === 'function' ? (value as () => T)() : value;
}
