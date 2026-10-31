import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import type { PersistedClient, Persister } from '@tanstack/query-persist-client-core';
import { del, get, set } from 'idb-keyval';
import { z } from 'zod';

import { attempt, isFailure } from '@arki/failure';
import { getLogger } from '@arki/log';
import { parse } from '@arki/schema';

import { offlineSerializer } from '../serializer.ts';
import { QueryCachePersistFailed } from './failures.ts';

/** Enable with `DEBUG=arki:offline:query`. */
const debugPersister = getLogger('arki:offline:query');

export type CreateIdbPersisterOptions = {
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
   * the older snapshot. Resolves `offline.query_cache_persist_failed` when IndexedDB refuses (storage
   * full, private mode) or the cache cannot be serialized.
   */
  persistClientNow: (client: PersistedClient) => Promise<void | ReturnType<typeof QueryCachePersistFailed>>;
};

/**
 * What a stored cache must look like before TanStack restores it. TanStack owns the shape of the
 * dehydrated queries and mutations (it changes with its version), so only the envelope and the
 * entries' identity are checked here; `buster` and `maxAge` reject anything stale or foreign.
 */
const storedClientSchema = z.custom<PersistedClient>(
  value =>
    z
      .object({
        timestamp: z.number(),
        buster: z.string(),
        clientState: z.object({
          mutations: z.array(z.looseObject({})),
          queries: z.array(z.looseObject({ queryHash: z.string(), queryKey: z.array(z.unknown()) })),
        }),
      })
      .safeParse(value).success,
);

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
    throttleTime: 1000,
    serialize: (client) => offlineSerializer.stringify(client),
    deserialize: (text) => {
      const stored = parse(storedClientSchema, offlineSerializer.parse(text));
      if (isFailure(stored)) throw new Error('The stored query cache does not match its shape', { cause: stored });
      return stored;
    },
  });

  return {
    ...throttled,
    // A stored cache that does not match its shape (an old build, a bad write) is dropped and refetched.
    restoreClient: async () => {
      try {
        return await throttled.restoreClient();
      } catch (error) {
        debugPersister.debug('dropping the stored query cache: {reason}', {
          reason: error instanceof Error ? error.message : String(error),
        });
        await throttled.removeClient();
        return;
      }
    },
    persistClientNow: client =>
      attempt(
        async () => {
          await set(key, offlineSerializer.stringify(client));
        },
        cause => QueryCachePersistFailed({ cause }),
      ),
  };
}
