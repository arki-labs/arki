import type { DefaultOptions } from '@tanstack/react-query';
import { QueryClient } from '@tanstack/react-query';

import { persistQueryClientSave } from '@tanstack/query-persist-client-core';

import type { IdbPersister } from './idb-persister.ts';
import { createIdbPersister } from './idb-persister.ts';
import type { QueryCachePersistFailed } from './failures.ts';

 
/// <reference path="./vite-env.d.ts" />

export type CreatePersistedQueryClientOptions = {
  /**
   * The key used to store the persisted QueryClient cache in IndexedDB.
   * @default 'arki-offline-query'
   */
  storageKey?: string;
  /**
   * Maximum age of the persisted cache in milliseconds. Caches older than
   * this will be discarded on restore.
   * @default 86_400_000 (24 hours)
   */
  maxAge?: number;
  /**
   * A buster string that, when changed, invalidates any previously persisted
   * cache. Defaults to `import.meta.env.VITE_BUILD_ID` so a new deploy
   * automatically busts stale caches.
   * @default import.meta.env.VITE_BUILD_ID ?? ''
   */
  buster?: string;
  /**
   * Default options forwarded to the QueryClient constructor.
   */
  defaultOptions?: DefaultOptions;
}

export type PersistedQueryClient = {
  queryClient: QueryClient;
  persister: IdbPersister;
  /**
   * Writes the whole cache to IndexedDB now and resolves when it is stored. Await it after removing
   * a query that must never come back (a deleted item) and before the page can reload; the
   * provider's own writes are throttled to one a second.
   */
  persistNow: () => Promise<void | ReturnType<typeof QueryCachePersistFailed>>;
  /** Resolved buster string — forward to `PersistedQueryClientProvider`. */
  buster: string;
  /** Resolved max age in ms — forward to `PersistedQueryClientProvider`. */
  maxAge: number;
}

const DEFAULT_STORAGE_KEY = 'arki-offline-query';
const DEFAULT_MAX_AGE_MS = 1000 * 60 * 60 * 24; // 24 hours

/**
 * Creates a TanStack QueryClient paired with an IndexedDB-backed persister.
 *
 * The pair should be passed to `PersistedQueryClientProvider` (or to
 * `PersistQueryClientProvider` from `@tanstack/react-query-persist-client`
 * directly) so the cache survives page reloads and short network outages.
 *
 * @example
 * ```tsx
 * const { queryClient, persister } = createPersistedQueryClient();
 *
 * function App() {
 *   return (
 *     <PersistedQueryClientProvider client={queryClient} persister={persister}>
 *       <YourApp />
 *     </PersistedQueryClientProvider>
 *   );
 * }
 * ```
 */
export function createPersistedQueryClient(
  options: CreatePersistedQueryClientOptions = {},
): PersistedQueryClient {
  const {
    storageKey = DEFAULT_STORAGE_KEY,
    maxAge = DEFAULT_MAX_AGE_MS,
    // eslint-disable-next-line turbo/no-undeclared-env-vars -- VITE_BUILD_ID is inlined by Vite at build time, not read from the Turbo env
    buster = import.meta.env.VITE_BUILD_ID ?? '',
    defaultOptions,
  } = options;

  const queryClient = new QueryClient({
    defaultOptions: {
      ...defaultOptions,
      queries: {
        gcTime: maxAge,
        ...defaultOptions?.queries,
      },
    },
  });

  const persister = createIdbPersister({ storageKey });

  const persistNow = async (): Promise<void | ReturnType<typeof QueryCachePersistFailed>> => {
    let outcome: ReturnType<typeof QueryCachePersistFailed> | undefined;
    await persistQueryClientSave({
      queryClient,
      persister: {
        ...persister,
        persistClient: async client => {
          const written = await persister.persistClientNow(client);
          if (written !== undefined) outcome = written;
        },
      },
      buster,
    });
    return outcome;
  };

  return { queryClient, persister, persistNow, buster, maxAge };
}
