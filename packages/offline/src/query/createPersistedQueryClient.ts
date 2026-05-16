import type { DefaultOptions } from '@tanstack/react-query';
import type { Persister } from '@tanstack/query-persist-client-core';
import { QueryClient } from '@tanstack/react-query';

import { createIdbPersister } from './idb-persister.ts';

// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./vite-env.d.ts" />

export interface CreatePersistedQueryClientOptions {
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

export interface PersistedQueryClient {
  queryClient: QueryClient;
  persister: Persister;
  /** Resolved buster string — forward to `PersistedQueryClientProvider`. */
  buster: string;
  /** Resolved max age in ms — forward to `PersistedQueryClientProvider`. */
  maxAge: number;
}

const DEFAULT_STORAGE_KEY = 'arki-offline-query';
const DEFAULT_MAX_AGE_MS = 1_000 * 60 * 60 * 24; // 24 hours

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

  return { queryClient, persister, buster, maxAge };
}
