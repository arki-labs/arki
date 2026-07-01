import type { ReactNode } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type { Persister } from '@tanstack/query-persist-client-core';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import type { PersistQueryClientProviderProps } from '@tanstack/react-query-persist-client';

/**
 * The `dehydrateOptions` type sourced from `PersistQueryClientProvider`'s OWN
 * props, not from `@tanstack/react-query`. `query-persist-client-core` bundles a
 * distinct copy of `@tanstack/query-core`, so a `DehydrateOptions` imported from
 * react-query is nominally incompatible (TS2322) even though it's structurally
 * identical. Indexed access pins the exact query-core instance the persister uses.
 */
type PersistDehydrateOptions = NonNullable<PersistQueryClientProviderProps['persistOptions']>['dehydrateOptions'];

export type PersistedQueryClientProviderProps = {
  /** The QueryClient instance created by `createPersistedQueryClient`. */
  client: QueryClient;
  /** The persister instance created by `createPersistedQueryClient`. */
  persister: Persister;
  /**
   * Maximum age of the persisted cache in milliseconds. Caches older than
   * this will be discarded on restore.
   * @default 86_400_000 (24 hours)
   */
  maxAge?: number;
  /**
   * A buster string that, when changed, invalidates any previously persisted
   * cache.
   */
  buster?: string;
  /**
   * Controls which queries are written to the PERSISTENT store, independent of
   * the QueryClient's SSR `dehydrate` default. Forward a `{ shouldDehydrateQuery }`
   * here to persist offline-relevant queries WITHOUT pulling them into the SSR
   * payload. This decoupling matters because SSR dehydration and offline
   * persistence both flow through the same `dehydrate()`: an app whose
   * client-level `shouldDehydrateQuery` is a restrictive allow-list (tuned for
   * SSR serialization safety) would otherwise silently persist nothing — the
   * offline cache stays empty. Omit to fall back to the client default.
   */
  dehydrateOptions?: PersistDehydrateOptions;
  children: ReactNode;
};

/**
 * Thin wrapper around `PersistQueryClientProvider` that accepts a pre-built
 * `client` + `persister` pair (from `createPersistedQueryClient`) and forwards
 * the optional `maxAge` and `buster` into `persistOptions`.
 *
 * @example
 * ```tsx
 * const { queryClient, persister } = createPersistedQueryClient();
 *
 * <PersistedQueryClientProvider client={queryClient} persister={persister}>
 *   <App />
 * </PersistedQueryClientProvider>
 * ```
 */
export function PersistedQueryClientProvider({
  client,
  persister,
  maxAge,
  buster,
  dehydrateOptions,
  children,
}: PersistedQueryClientProviderProps): React.JSX.Element {
  return (
    <PersistQueryClientProvider
      client={client}
      persistOptions={{ persister, maxAge, buster, dehydrateOptions }}
    >
      {children}
    </PersistQueryClientProvider>
  );
}
