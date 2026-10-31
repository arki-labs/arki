export { createIdbPersister } from './idb-persister.ts';
export type { CreateIdbPersisterOptions, IdbPersister } from './idb-persister.ts';

export { QueryCachePersistFailed } from './failures.ts';

export { createPersistedQueryClient } from './createPersistedQueryClient.ts';
export type {
  CreatePersistedQueryClientOptions,
  PersistedQueryClient,
} from './createPersistedQueryClient.ts';

export { PersistedQueryClientProvider } from './PersistedQueryClientProvider.tsx';
export type { PersistedQueryClientProviderProps } from './PersistedQueryClientProvider.tsx';

// `useIsRestoring` reads the `IsRestoringProvider` context that
// `PersistedQueryClientProvider` sets while the persisted cache hydrates from
// IndexedDB. The consumer hook lives in `@tanstack/react-query` (which owns the
// context); persist-client only *produces* the value. Re-exported here so app
// code reads it within the `@arki/offline` boundary alongside the provider.
export { useIsRestoring } from '@tanstack/react-query';
