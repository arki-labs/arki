import type { Configured, InternalLogging, Logger } from './logging.js';
import type { Fields, LogConfig } from './types.js';
import { createInternalLogging, isInternalLogging } from './logging.js';

/** Where the default instance lives, so two copies of the package in one process share it (RFC §8.2). */
export const DEFAULT_KEY: unique symbol = Symbol.for('@arki/log/default@1');

/** The default instance, created on first use (never at import). */
export function defaultLogging(): InternalLogging {
  const existing: unknown = Reflect.get(globalThis, DEFAULT_KEY);
  if (isInternalLogging(existing)) return existing;
  const created = createInternalLogging();
  Object.defineProperty(globalThis, DEFAULT_KEY, {
    value: created,
    configurable: true,
    writable: false,
    enumerable: false,
  });
  return created;
}

/** A logger for a `:`-separated category; no argument is the root category `''`. Safe at module scope. */
export function getLogger(category?: string): Logger {
  return defaultLogging().getLogger(category);
}

/** Configures the default instance, once, at the app entry. A second call throws `ARKI_LOG_E001`. */
export function configure<const C extends string>(config: LogConfig<C>): Configured<C> {
  return defaultLogging().configure(config);
}

/** Runs `fn` with fields every record inside carries. Async code needs `asyncContext()` installed. */
export function withContext<R>(fields: Fields, fn: () => R): R {
  return defaultLogging().withContext(fields, fn);
}

/** App-wide fields on every record. Later calls add to (and override) earlier ones. */
export function shareContext(fields: Fields): void {
  defaultLogging().shareContext(fields);
}
