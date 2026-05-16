import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import type { Persister } from '@tanstack/query-persist-client-core';
import { del, get, set } from 'idb-keyval';

export interface CreateIdbPersisterOptions {
  /**
   * The key used to store the persisted QueryClient cache in IndexedDB.
   * @default 'arki-offline-query'
   */
  storageKey?: string;
}

/**
 * Creates an async storage persister backed by IndexedDB via idb-keyval.
 *
 * The `storageKey` is used as the single IDB key under which the entire
 * serialized QueryClient cache is stored.
 */
export function createIdbPersister(options: CreateIdbPersisterOptions = {}): Persister {
  const key = options.storageKey ?? 'arki-offline-query';

  return createAsyncStoragePersister({
    storage: {
      getItem: (storageKey) => get<string>(storageKey).then((v) => v ?? null),
      setItem: (storageKey, value) => set(storageKey, value),
      removeItem: (storageKey) => del(storageKey),
    },
    key,
    throttleTime: 1_000,
  });
}
