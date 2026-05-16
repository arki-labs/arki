/**
 * IDB-backed queue storage for OfflineMutationQueue.
 *
 * Wraps idb-keyval with a single key holding the full FIFO array.
 * Uses superjson for serialization to preserve Date, Map, BigInt, etc.
 */
import { get, set, del } from 'idb-keyval';
import superjson from 'superjson';

import type { QueuedMutation } from './queue.ts';

export interface QueueStorage {
  read(): Promise<QueuedMutation[]>;
  write(entries: QueuedMutation[]): Promise<void>;
  clear(): Promise<void>;
}

export function createQueueStorage(storageKey: string): QueueStorage {
  return {
    async read(): Promise<QueuedMutation[]> {
      const raw = await get<string>(storageKey);
      if (!raw) return [];
      try {
        return superjson.parse<QueuedMutation[]>(raw);
      } catch {
        // Corrupted storage — return empty to self-heal
        return [];
      }
    },

    async write(entries: QueuedMutation[]): Promise<void> {
      await set(storageKey, superjson.stringify(entries));
    },

    async clear(): Promise<void> {
      await del(storageKey);
    },
  };
}
