import type { ReactNode } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type { Persister } from '@tanstack/query-persist-client-core';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';

export interface PersistedQueryClientProviderProps {
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
  children: ReactNode;
}

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
  children,
}: PersistedQueryClientProviderProps): React.JSX.Element {
  return (
    <PersistQueryClientProvider
      client={client}
      persistOptions={{ persister, maxAge, buster }}
    >
      {children}
    </PersistQueryClientProvider>
  );
}
