/**
 * IDB-backed queue storage for OfflineMutationQueue.
 *
 * Wraps idb-keyval with a single key holding the full FIFO array.
 * Uses the package serializer (SuperJSON + Temporal) to preserve Date, Map, BigInt and Temporal values.
 */
import { get, set, del } from 'idb-keyval';

import type { QueuedMutation } from './queue.ts';

import { getLogger } from '@arki/log';

import { offlineSerializer } from '../serializer.ts';

const log = getLogger('arki:offline:mutations');

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

/**
 * The last actor signed in on this device: one string under its own key.
 * A write queued while the session is unknown (an offline reload) is bound
 * to it, so it can replay for that same user once they are signed in again.
 */
export type LastActorStore = {
  read(): Promise<string | null>;
  remember(actorId: string): Promise<void>;
};

export function createLastActorStore(storageKey: string): LastActorStore {
  // undefined: not read from storage yet.
  let known: string | null | undefined;
  return {
    async read(): Promise<string | null> {
      if (known === undefined) {
        const raw = await get<unknown>(storageKey);
        known ??= typeof raw === 'string' ? raw : null;
      }
      return known;
    },

    async remember(actorId: string): Promise<void> {
      if (known === actorId) return;
      known = actorId;
      try {
        await set(storageKey, actorId);
      } catch (error) {
        // Memory still holds it for this page; only a reload forgets it.
        log.debug('Could not store the last actor: {error}', { error: error instanceof Error ? error : String(error) });
      }
    },
  };
}
