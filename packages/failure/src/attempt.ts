/**
 * The boundary with code that throws (`JSON.parse`, `fetch`, a driver, a
 * third-party SDK): run it, and turn a throw into a value you choose, usually
 * a failure. The mapper is required, so no failure is ever typed `unknown`.
 */
import { isThenable } from './failure.js';

/**
 * Run `run`. If it throws (or its promise rejects), return `onThrow(cause)`
 * instead. A mapper that throws itself passes the error on, so it can map the
 * errors it knows and rethrow the rest.
 *
 * @example
 * const body = attempt(() => JSON.parse(text) as unknown, cause => InvalidJson({ reason: String(cause) }));
 * //    ^? unknown | Failure<'request.invalid_json', { reason: string }>
 * const page = await attempt(() => fetchPage(url), () => null); // like Laravel's rescue()
 */
export function attempt<Value, Mapped>(
  run: () => PromiseLike<Value>,
  onThrow: (cause: unknown) => Mapped,
): Promise<Value | Mapped>;
export function attempt<Value, Mapped>(run: () => Value, onThrow: (cause: unknown) => Mapped): Value | Mapped;
export function attempt(run: () => unknown, onThrow: (cause: unknown) => unknown): unknown {
  let value: unknown;
  try {
    value = run();
  } catch (error) {
    return onThrow(error);
  }
  return isThenable(value) ? Promise.resolve(value).then(undefined, onThrow) : value;
}
