import { isFailure } from '@arki/failure';
// #region run-once
import { createLocks, LockHeld } from '@arki/lock';
import { memoryStore } from '@arki/lock/memory';

const locks = createLocks({ store: memoryStore(), namespace: 'pizzeria' });

/** Grab the last slice unless someone else is already reaching for it. */
export async function grabLastSlice(grab: () => Promise<number>) {
  const result = await locks.mutex('last-slice').tryRun(async ({ signal }) => {
    signal.throwIfAborted(); // aborts if the lock is lost
    return grab();
  });
  if (LockHeld.is(result)) return 'skipped: someone else already has the last slice';
  if (isFailure(result)) return result;
  return `sent ${result}`;
}
// #endregion run-once

// #region overlap
/** Two callers at once: one runs, the other is told the lock is busy. */
export async function overlap() {
  const first = grabLastSlice(async () => {
    await new Promise(resolve => setTimeout(resolve, 20)); // the first caller is slow
    return 3;
  });
  await Promise.resolve();
  const second = await grabLastSlice(async () => 3);
  return [await first, second] as const;
}
// #endregion overlap
