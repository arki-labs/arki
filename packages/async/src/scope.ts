import { abortedError, cleanupFailed } from './errors.js';
import { linkedController } from './signal.js';

/** Options of {@link scoped}. */
export type ScopedOptions = {
  /** Aborting it aborts `scope.signal`. Already aborted: the body never runs and the call rejects with `ARKI_ASYNC_E002`. */
  readonly signal?: AbortSignal;
};

/** What a {@link scoped} body gets: one signal and one cleanup stack for everything it starts. */
export type Scope = {
  /**
   * Aborts when the outer signal aborts, when the body rejects (reason: the
   * body error), or when the scope ends (so stragglers stop). Pass it to every
   * piece of work the body starts.
   */
  readonly signal: AbortSignal;
  /**
   * Opens a resource and registers `close` for it. `close` is registered only
   * after `open` succeeds, so a failed open is never closed. If the scope has
   * already ended when `open` returns, the resource is closed at once and the
   * call rejects with `ARKI_ASYNC_E002`.
   */
  acquire<R>(open: (signal: AbortSignal) => Promise<R> | R, close: (resource: R) => Promise<void> | void): Promise<R>;
  /** Registers a finalizer for scope exit. Throws `ARKI_ASYNC_E002` once the scope has ended. */
  defer(finalizer: () => Promise<void> | void): void;
};

/**
 * Runs `body` with an owned lifetime: whatever it acquires or defers is
 * released when it ends, whether it resolves or rejects.
 *
 * On exit `scope.signal` aborts first, then the finalizers run one at a time,
 * newest first, each awaited. All of them run even when one throws.
 *
 * - Body resolves, cleanup clean: resolves with the body's value.
 * - Body rejects, cleanup clean: rejects with the body error, unchanged.
 * - Any finalizer throws: rejects with `ARKI_ASYNC_E003`; `cause` is the body
 *   error (or `undefined`) and `errors` lists the finalizer errors in the
 *   order they ran. No error is lost.
 */
export async function scoped<T>(body: (scope: Scope) => Promise<T>, options: ScopedOptions = {}): Promise<T> {
  const { signal: outer } = options;
  if (outer?.aborted) throw abortedError('scoped()', outer.reason);
  const { controller, unlink } = linkedController(outer);
  const { signal } = controller;
  const finalizers: (() => Promise<void> | void)[] = [];
  let ended = false;

  /** Adds a finalizer unless the scope has ended; returns whether it was added. */
  function register(finalizer: () => Promise<void> | void): boolean {
    if (ended) return false;
    finalizers.push(finalizer);
    return true;
  }

  const scope: Scope = {
    signal,
    async acquire(open, close) {
      if (ended) throw abortedError('scope.acquire()', signal.reason);
      const resource = await open(signal);
      if (!register(() => close(resource))) {
        // A straggler: the scope ended while `open` ran. Do not leak the resource.
        await close(resource);
        throw abortedError('scope.acquire()', signal.reason);
      }
      return resource;
    },
    defer(finalizer) {
      if (!register(finalizer)) throw abortedError('scope.defer()', signal.reason);
    },
  };

  // Set when `body` fulfills; otherwise `failure` holds what it threw.
  let result: { readonly value: T } | undefined;
  let failure: unknown;
  try {
    result = { value: await body(scope) };
  } catch (error) {
    failure = error;
  }

  ended = true;
  unlink();
  if (result === undefined) controller.abort(failure);
  else controller.abort();

  const errors: unknown[] = [];
  for (const finalizer of [...finalizers].reverse()) {
    try {
      await finalizer();
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length > 0) throw cleanupFailed(result === undefined ? failure : undefined, errors);
  if (result === undefined) throw failure;
  return result.value;
}
