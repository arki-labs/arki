/**
 * @internal A child `AbortController` that also aborts when `parent` aborts,
 * with the parent's reason. `unlink` removes the parent listener so a
 * long-lived parent signal does not keep finished work alive.
 *
 * Hand-rolled instead of `AbortSignal.any`, which Hermes (React Native) lacks.
 */
export function linkedController(parent: AbortSignal | undefined): {
  readonly controller: AbortController;
  readonly unlink: () => void;
} {
  const controller = new AbortController();
  const onAbort = (): void => {
    controller.abort(parent?.reason);
  };
  parent?.addEventListener('abort', onAbort, { once: true });
  return { controller, unlink: () => parent?.removeEventListener('abort', onAbort) };
}

/** @internal Calls `task` now; a synchronous throw becomes a rejected promise. */
export function attempt<T>(task: () => Promise<T> | T): Promise<T> {
  return new Promise<T>(resolve => {
    resolve(task());
  });
}

/** @internal How a piece of work ended, carried through a promise that never rejects. */
export type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

/** @internal Unwraps an {@link Outcome}: returns the value or throws the error unchanged. */
export function unwrap<T>(outcome: Outcome<T>): T {
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
