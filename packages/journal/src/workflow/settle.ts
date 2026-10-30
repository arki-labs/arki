/**
 * The wait of `def.settled` and `def.startAndWait`: input checks that throw (misuse), and a poll with a growing pause.
 * A wait never writes and never changes the run it waits for.
 */
import { sleep } from '@arki/async';

import { JournalError } from '../errors.js';

/** The longest wait, in seconds. A caller that needs longer should take the run id and read it later. */
export const SETTLE_LIMIT_SECONDS = 30;
const FIRST_PAUSE_MS = 10;
const LONGEST_PAUSE_MS = 250;

/** The wait in milliseconds. A missing, non-numeric, non-positive or too long wait is misuse and throws `BAD_ARGUMENT`. */
export function waitMs(seconds: unknown, option: string, who: string): number {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0 || seconds > SETTLE_LIMIT_SECONDS) {
    throw new JournalError(
      'BAD_ARGUMENT',
      'workflow',
      who,
      `${option} must be a number of seconds above 0 and at most ${SETTLE_LIMIT_SECONDS}; for a longer wait take the run id and read the run later`,
    );
  }
  return seconds * 1000;
}

/** A Drizzle transaction has `rollback()`; the root database does not. A wait in a transaction would hold it open. */
export function refuseTransaction(db: { readonly rollback?: unknown }, verb: string, who: string): void {
  if (typeof db.rollback === 'function') {
    throw new JournalError(
      'BAD_ARGUMENT',
      'workflow',
      who,
      `${verb} needs the root database, not a transaction: a wait inside a transaction holds it open and never sees the run end`,
    );
  }
}

/**
 * Calls `attempt` until it returns something, `ms` pass or `signal` aborts. The first call is always made. The pause
 * starts at 10 ms and doubles to 250 ms. `undefined` from `attempt` means "not yet"; a result of `undefined` means the
 * wait ran out.
 */
export async function pollUntil<Found>(
  ms: number,
  signal: AbortSignal | undefined,
  attempt: () => Promise<Found | undefined>,
): Promise<Found | undefined> {
  const endsAt = Date.now() + ms;
  let pause = FIRST_PAUSE_MS;
  for (;;) {
    const found = await attempt();
    if (found !== undefined) return found;
    const left = endsAt - Date.now();
    if (left <= 0 || signal?.aborted === true) return undefined;
    // A failed sleep is an abort or a clock defect: either way the wait is over.
    const slept = signal === undefined ? await sleep(Math.min(pause, left)) : await sleep(Math.min(pause, left), { signal });
    if (slept !== undefined) return undefined;
    pause = Math.min(pause * 2, LONGEST_PAUSE_MS);
  }
}
