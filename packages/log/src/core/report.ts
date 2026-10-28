// Logging must never throw into the code that logs, and a failure inside a
// timer (buffer, deduplicate) must never become an uncaught exception. A
// failing sink or processor is reported once on `console.error`, then skipped
// quietly. The report does not go through logging, so it cannot recurse.

const reported = new WeakSet<object>();

export function reportFailure(source: object, what: string, error: unknown): void {
  if (reported.has(source)) return;
  reported.add(source);
  try {
    // Diagnostics are observations too: even a broken console cannot escape.
    void Promise.resolve(
      console.error(`@arki/log: ${what} threw; later failures from it are not reported.`, error),
    ).catch(() => {
      // A failed diagnostic has no further safe reporting destination.
    });
  } catch {
    // There is no further safe reporting destination.
  }
}

/** Observes async returns even from callbacks whose TypeScript signature is void. */
export function observeRejection(result: unknown, source: object, what: string): void {
  try {
    if (result === null || (typeof result !== 'object' && typeof result !== 'function') || !('then' in result)) return;
    void Promise.resolve(result).catch(error => reportFailure(source, what, error));
  } catch (error) {
    reportFailure(source, what, error);
  }
}
