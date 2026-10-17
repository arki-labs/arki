import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import type { PersistedClient, Persister } from '@tanstack/query-persist-client-core';
import { del, get, set } from 'idb-keyval';

import { offlineSerializer } from '../serializer.ts';

export interface CreateIdbPersisterOptions {
  /**
   * The key used to store the persisted QueryClient cache in IndexedDB.
   * @default 'arki-offline-query'
   */
  storageKey?: string;
}

/** A persister that can also write the cache at once, for callers that must know the write is done. */
export type IdbPersister = Persister & {
  /**
   * Writes `client` now and resolves when it is stored. `persistClient` is throttled to one write a
   * second and does not say when it finishes; a page that reloads right after a delete would restore
   * the older snapshot.
   */
  persistClientNow: (client: PersistedClient) => Promise<void>;
};

/**
 * Creates an async storage persister backed by IndexedDB via idb-keyval.
 *
 * The `storageKey` is used as the single IDB key under which the entire
 * serialized QueryClient cache is stored. The cache is written with SuperJSON
 * (Temporal types registered), so dates and Temporal values restore typed.
 * A cache written as plain JSON restores as empty and is refetched.
 */
export function createIdbPersister(options: CreateIdbPersisterOptions = {}): IdbPersister {
  const key = options.storageKey ?? 'arki-offline-query';

  const throttled = createAsyncStoragePersister({
    storage: {
      getItem: (storageKey) => get<string>(storageKey).then((v) => v ?? null),
      setItem: (storageKey, value) => set(storageKey, value),
      removeItem: (storageKey) => del(storageKey),
    },
    key,
    throttleTime: 1_000,
    serialize: (client) => offlineSerializer.stringify(client),
    deserialize: (text) => offlineSerializer.parse<PersistedClient>(text),
  });

  return {
    ...throttled,
    persistClientNow: client => set(key, offlineSerializer.stringify(client)),
  };
}
