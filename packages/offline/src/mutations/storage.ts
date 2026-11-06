import { get, set, del } from 'idb-keyval';

import { queuedMutationSchema } from './model-schemas.js';
import type { QueuedMutation } from './model.js';
import { QueuePersistenceUnconfirmed, QueueStorageCorrupt, QueueStorageUnavailable } from './failures.js';
import type { QueueStorageFailure } from './failures.js';
import { readOfflineState, writeOfflineState } from './state.js';
import { observeQueue } from './telemetry.js';

export type QueueStorage = {
  read(): Promise<QueuedMutation[] | QueueStorageFailure>;
  write(entries: QueuedMutation[]): Promise<void | QueueStorageFailure>;
  clear(): Promise<void | QueueStorageFailure>;
};

export function createQueueStorage(storageKey: string): QueueStorage {
  return {
    read: () => readOfflineState(storageKey, queuedMutationSchema.array(), []),
    write: entries => writeOfflineState(storageKey, entries, queuedMutationSchema.array()),
    clear: () => observeQueue('offline.storage.clear', async () => {
      try { await del(storageKey); }
      catch (error) { return QueuePersistenceUnconfirmed({ cause: error }); }
      return;
    }),
  };
}

export type LastActorStore = {
  read(): Promise<string | null | QueueStorageFailure>;
  remember(actorId: string): Promise<void | QueueStorageFailure>;
  forget(): Promise<void | QueueStorageFailure>;
};

export function createLastActorStore(storageKey: string): LastActorStore {
  let known: string | null | undefined;
  return {
    read: () => observeQueue('offline.actor.read', async () => {
      if (known !== undefined) return known;
      let raw: unknown;
      try { raw = await get<unknown>(storageKey); }
      catch (error) { return QueueStorageUnavailable({ cause: error }); }
      if (raw !== undefined && typeof raw !== 'string') return QueueStorageCorrupt();
      known ??= typeof raw === 'string' ? raw : null;
      return known;
    }),
    remember: actorId => observeQueue('offline.actor.remember', async () => {
      if (known === actorId) return;
      known = actorId;
      try { await set(storageKey, actorId); }
      catch (error) { return QueuePersistenceUnconfirmed({ cause: error }); }
      return;
    }),
    forget: () => observeQueue('offline.actor.forget', async () => {
      if (known === null) return;
      known = null;
      try { await del(storageKey); }
      catch (error) { return QueuePersistenceUnconfirmed({ cause: error }); }
      return;
    }),
  };
}
