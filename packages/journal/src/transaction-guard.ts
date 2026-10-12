/**
 * The guard that allows one journal operation per transaction at a time.
 * Its `WeakMap` is the only module-level state in the library, and it must stay
 * module-scoped: see the comment on it.
 * Imports nothing from this package. `write` and `command` import it.
 */
import { is } from 'drizzle-orm';
import { PgAsyncTransaction } from 'drizzle-orm/pg-core';

/** Passed to `then` twice: waits for a promise to settle, whether it resolves or rejects. */
const ignoreSettlement = (): undefined => undefined;

/**
 * Savepoints are a stack. Two journal operations open on one transaction at the
 * same time release each other's savepoint, so a caught failure of one could
 * erase what the other wrote. A transaction therefore holds one operation at a
 * time. A second one is refused: it waits for the first to settle (so the
 * caller's rollback undoes it whole), then rejects. A child runs on its own
 * savepoint handle, so nesting is fine. The root database opens a separate
 * transaction per operation and is never busy.
 *
 * The map is module-scoped on purpose. Two journals can run on one transaction,
 * and then they share its savepoint stack, so they must share this guard too.
 * Do not move it into the journal factory.
 */
const inFlight = new WeakMap<object, Promise<unknown>>();
export function oneAtATime<T>(handle: object, what: string, work: () => Promise<T>): Promise<T> {
  if (!is(handle, PgAsyncTransaction)) return work();
  const busy = inFlight.get(handle);
  if (busy !== undefined) {
    return busy.then(ignoreSettlement, ignoreSettlement).then(() => {
      throw new Error(
        `journal: ${what} started on a transaction that already has a journal operation in flight; await operations on one transaction one at a time`,
      );
    });
  }
  // eslint-disable-next-line drizzle/enforce-delete-with-where -- WeakMap#delete, not a Drizzle query
  const running = work().finally(() => inFlight.delete(handle));
  inFlight.set(handle, running);
  return running;
}
