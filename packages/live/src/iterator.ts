/** A settled call's outcome is its caller's; the queue only waits for it. */
const ignore = (): void => {
  // The caller of that call already got its result or error.
};

/**
 * @internal An async iterator without an async generator. Hermes (React
 * Native) cannot compile `async function*`, and the client, the hub and the
 * endpoint all run there, so each stream is a `pull` step plus a `cleanup`.
 *
 * It keeps the promises a generator made:
 * - calls run one at a time, in order (a `return()` waits for a pending `next()`);
 * - `cleanup` runs once: when `pull` says done, when `pull` throws (then the
 *   error goes on, unless `cleanup` throws its own), or on `return()`;
 * - after that, `next()` is done and `return()` does nothing.
 *
 * One difference, on purpose: a `return()` before the first `next()` runs
 * `cleanup` too. A generator skipped its `finally` there and leaked what the
 * caller had already set up.
 */
export function pullIterator<T>(
  // `NoInfer`: `T` comes from the caller's declared iterator type, not from a done result's `undefined`.
  pull: () => Promise<IteratorResult<NoInfer<T>, void>>,
  cleanup: () => void | Promise<void>,
): AsyncIterableIterator<T, void, undefined> {
  const finished: IteratorReturnResult<void> = { done: true, value: undefined };
  let over = false;
  /** The call before this one; each call starts when it settles. */
  let previous: Promise<unknown> = Promise.resolve();

  async function finish(): Promise<void> {
    if (over) return;
    over = true;
    await cleanup();
  }

  function inTurn<R>(step: () => Promise<R>): Promise<R> {
    const run = previous.then(step);
    previous = run.catch(ignore);
    return run;
  }

  return {
    next: () =>
      inTurn(async () => {
        if (over) return finished;
        const result = await pull().catch(async (error: unknown) => {
          await finish();
          throw error;
        });
        if (result.done === true) await finish();
        return result;
      }),
    return: () =>
      inTurn(async () => {
        await finish();
        return finished;
      }),
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}
