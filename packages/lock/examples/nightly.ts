// #region run-once
import { createLocks, LockHeld } from '@arki/lock';
import { memoryStore } from '@arki/lock/memory';

const locks = createLocks({ store: memoryStore(), namespace: 'billing' });

/** Send invoices unless another caller is already doing it. */
export async function sendInvoices(send: () => Promise<number>): Promise<string> {
  const result = await locks.mutex('send-invoices').tryRun(async ({ signal }) => {
    signal.throwIfAborted(); // aborts if the lock is lost
    return send();
  });
  if (LockHeld.is(result)) return 'skipped: another caller holds the lock';
  return `sent ${result}`;
}
// #endregion run-once

// #region overlap
/** Two callers at once: one runs, the other is told the lock is busy. */
export async function overlap(): Promise<[string, string]> {
  const first = sendInvoices(async () => {
    await new Promise(resolve => setTimeout(resolve, 20)); // the first caller is slow
    return 3;
  });
  await Promise.resolve();
  const second = await sendInvoices(async () => 3);
  return [await first, second];
}
// #endregion overlap
