import { z } from '@arki/contracts';
import { isFailure } from '@arki/failure';
import { queuedMutationSchema } from './model.ts';
import type { QueuedMutation } from './model.ts';
import type { QueuedMutationId } from './identity.ts';
import type { QueueStorageFailure } from './failures.ts';
import { readOfflineState, writeOfflineState } from './storage.ts';
import { observeQueue } from './telemetry.ts';

const deadLetterEntrySchema = z.object({
  mutation: queuedMutationSchema,
  error: z.object({ message: z.string(), name: z.string() }),
  deadLetteredAt: z.number().finite(),
});
export type DeadLetterEntry = z.output<typeof deadLetterEntrySchema>;

export type DeadLetterStore = {
  list(): Promise<readonly QueuedMutation[] | QueueStorageFailure>;
  add(entry: QueuedMutation, error: Error): Promise<void | QueueStorageFailure>;
  remove(id: QueuedMutationId): Promise<void | QueueStorageFailure>;
  subscribe(listener: () => void): () => void;
};

export function createDeadLetterStore(storageKey: string): DeadLetterStore {
  const listeners = new Set<() => void>();
  const readAll = () => readOfflineState(storageKey, deadLetterEntrySchema.array(), []);
  const reporting = new Set<() => void>();
  function notify(): void {
    for (const listener of listeners) {
      if (reporting.has(listener)) continue;
      reporting.add(listener);
      try {
        // Only this observer is guarded while its asynchronous report is pending.
        void Promise.resolve(listener()).catch(() => { /* Reporting cannot revoke a committed write. */ }).finally(() => { reporting.delete(listener); });
      } catch { reporting.delete(listener); }
    }
  }
  return {
    list: () => observeQueue('offline.dead_letter.list', async () => {
      const entries = await readAll();
      if (isFailure(entries)) return entries;
      return entries.map(entry => entry.mutation);
    }),
    add: (mutation, error) => observeQueue('offline.dead_letter.add', async () => {
      const entries = await readAll();
      if (isFailure(entries)) return entries;
      const entry: DeadLetterEntry = {
        mutation, error: { message: error.message, name: error.name }, deadLetteredAt: Date.now(),
      };
      const result = await writeOfflineState(storageKey, [...entries.filter(existing => existing.mutation.id !== mutation.id), entry], deadLetterEntrySchema.array());
      if (isFailure(result)) return result;
      notify();
      return;
    }),
    remove: id => observeQueue('offline.dead_letter.remove', async () => {
      const entries = await readAll();
      if (isFailure(entries)) return entries;
      const result = await writeOfflineState(storageKey, entries.filter(entry => entry.mutation.id !== id), deadLetterEntrySchema.array());
      if (isFailure(result)) return result;
      notify();
      return;
    }),
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
