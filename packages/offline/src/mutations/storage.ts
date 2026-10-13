/**
 * IDB-backed queue storage for OfflineMutationQueue.
 *
 * Wraps idb-keyval with a single key holding the full FIFO array.
 * Uses the package serializer (SuperJSON + Temporal) to preserve Date, Map, BigInt and Temporal values.
 */
import { get, set, del } from 'idb-keyval';

import type { QueuedMutation } from './queue.ts';

import { offlineSerializer } from '../serializer.ts';

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
        return offlineSerializer.parse<QueuedMutation[]>(raw);
      } catch {
        // Corrupted storage — return empty to self-heal
        return [];
      }
    },

    async write(entries: QueuedMutation[]): Promise<void> {
      await set(storageKey, offlineSerializer.stringify(entries));
    },

    async clear(): Promise<void> {
      await del(storageKey);
    },
  };
}
