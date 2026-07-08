/**
 * Defer an object's construction to its FIRST property access, memoized.
 *
 * The import-purity primitive: a module can export a shared instance
 * (`export const db = lazyObject(() => createDb(...))`) without observing
 * the world (env, connections) at import time — consumers keep plain value
 * semantics, construction happens on first use. Same split drizzle tables
 * have: declare everywhere, observe only at use.
 *
 * Methods are bound to the real instance (`get` delegates with the resolved
 * target as receiver), and `has`/`ownKeys`/`getOwnPropertyDescriptor`
 * delegate too, so spreads, `in` checks, and key enumeration behave.
 *
 * Not for primitives — the returned value must be used as an object
 * (property access), never compared by identity to the built instance.
 */
export function lazyObject<T extends object>(build: () => T): T {
  let built: T | undefined;
  const resolved = (): T => {
    built ??= build();
    return built;
  };

  return new Proxy({} as object, {
    get: (_target, property) => {
      const instance = resolved();
      const value = Reflect.get(instance, property, instance);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(instance) : value;
    },
    has: (_target, property) => Reflect.has(resolved(), property),
    ownKeys: () => Reflect.ownKeys(resolved()),
    getOwnPropertyDescriptor: (_target, property) => Object.getOwnPropertyDescriptor(resolved(), property),
  }) as T;
}
