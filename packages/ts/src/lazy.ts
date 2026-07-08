/**
 * Memoize a zero-argument computation: `compute` runs on the FIRST call,
 * every later call returns the same result — including `undefined` (the
 * guard is a flag, not the value). Works for async computations too, since
 * memoizing a promise-returning function memoizes the promise itself.
 *
 * This is the value-level laziness primitive; `lazyObject` builds on the
 * same idea and adds proxy transparency for object-typed results.
 *
 * Failure semantics: a synchronous throw is NOT memoized (the next call
 * retries), but a *returned* rejected promise IS — wrap with your own
 * retry if async boot failures must be retryable.
 */
export function once<T>(compute: () => T): () => T {
  let called = false;
  let result: T;
  return () => {
    if (!called) {
      result = compute();
      called = true;
    }
    return result;
  };
}

/**
 * A value or a zero-arg thunk producing it — the deferred-config shape DOT
 * adapters accept so a declaration can reference env without observing it
 * at module load: `kv(() => ({ url: env.REDIS_URL }))`. The adapter calls
 * {@link resolveLazy} at boot, which is where the observation belongs.
 *
 * Not for function-typed `T` — a thunk would be indistinguishable from the
 * value itself.
 */
export type Lazy<T> = T | (() => T);

/** Resolve a {@link Lazy}: call it if it is a thunk, return it otherwise. */
export function resolveLazy<T>(value: Lazy<T>): T {
  return typeof value === 'function' ? (value as () => T)() : value;
}

/**
 * Defer an object's construction to its FIRST property access, memoized.
 *
 * The import-purity primitive: a module can export a shared instance
 * (`export const db = lazyObject(() => createDb(...))`) without observing
 * the world (env, connections) at import time — consumers keep plain value
 * semantics, construction happens on first use. Same split drizzle tables
 * have: declare everywhere, observe only at use.
 *
 * Transparency: reads bind methods to the real instance; writes and
 * deletes go to the real instance (never the proxy's dummy target, where
 * they would silently vanish); the prototype is the instance's, so
 * `instanceof` answers truthfully; `in`, spreads, and key enumeration
 * delegate too.
 *
 * Not for primitives — the returned value must be used as an object
 * (property access), never compared by identity to the built instance.
 */
export function lazyObject<T extends object>(build: () => T): T {
  const resolved = once(build);

  return new Proxy({} as object, {
    get: (_target, property) => {
      const instance = resolved();
      const value = Reflect.get(instance, property, instance);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(instance) : value;
    },
    set: (_target, property, value) => Reflect.set(resolved(), property, value),
    deleteProperty: (_target, property) => Reflect.deleteProperty(resolved(), property),
    getPrototypeOf: () => Reflect.getPrototypeOf(resolved()),
    has: (_target, property) => Reflect.has(resolved(), property),
    ownKeys: () => Reflect.ownKeys(resolved()),
    getOwnPropertyDescriptor: (_target, property) => Object.getOwnPropertyDescriptor(resolved(), property),
  }) as T;
}
