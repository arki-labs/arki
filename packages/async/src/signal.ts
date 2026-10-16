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
