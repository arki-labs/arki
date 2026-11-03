import { get, set, del } from 'idb-keyval';
import type { z } from '@arki/contracts';

import { queuedMutationSchema } from './model.js';
import type { QueuedMutation } from './model.js';
import { QueueStorageCorrupt, QueueStorageUnavailable, QueuePersistenceUnconfirmed, QueueEncodingFailure } from './failures.js';
import type { QueueStorageFailure } from './failures.js';
import { observeQueue } from './telemetry.js';
import { offlineSerializer } from '../serializer.js';

export type QueueStorage = {
  read(): Promise<QueuedMutation[] | QueueStorageFailure>;
  write(entries: QueuedMutation[]): Promise<void | QueueStorageFailure>;
  clear(): Promise<void | QueueStorageFailure>;
};

/** Persistence decode boundary shared by the queue and dead-letter store. */
export async function readOfflineState<Schema extends z.ZodType>(storageKey: string, schema: Schema, empty: z.output<Schema>): Promise<z.output<Schema> | QueueStorageFailure> {
  return observeQueue('offline.storage.read', async () => {
    let raw: unknown;
    try { raw = await get<unknown>(storageKey); }
    catch (error) { return QueueStorageUnavailable({ cause: error }); }
    if (raw === undefined) return empty;
    try {
      if (typeof raw !== 'string') return QueueStorageCorrupt();
      const parsed: unknown = offlineSerializer.parse(raw);
      const result = schema.safeParse(parsed);
      return result.success ? result.data : QueueStorageCorrupt({ cause: result.error });
    } catch (error) { return QueueStorageCorrupt({ cause: error }); }
  });
}

export async function writeOfflineState(storageKey: string, value: unknown, schema: z.ZodType): Promise<void | QueueStorageFailure> {
  return observeQueue('offline.storage.write', async () => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) return QueueEncodingFailure({ cause: parsed.error });
    let encoded: string;
    try { encoded = offlineSerializer.stringify(parsed.data); }
    catch (error) { return QueueEncodingFailure({ cause: error }); }
    try { await set(storageKey, encoded); }
    catch (error) { return QueuePersistenceUnconfirmed({ cause: error }); }
    return;
  });
}

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
