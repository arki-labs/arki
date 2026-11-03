export { createIdbPersister } from './idb-persister.js';
export type { CreateIdbPersisterOptions, IdbPersister } from './idb-persister.js';

export { QueryCachePersistFailed } from './failures.js';

export { createPersistedQueryClient } from './createPersistedQueryClient.js';
export type {
  CreatePersistedQueryClientOptions,
  PersistedQueryClient,
} from './createPersistedQueryClient.js';

export { PersistedQueryClientProvider } from './PersistedQueryClientProvider.js';
export type { PersistedQueryClientProviderProps } from './PersistedQueryClientProvider.js';

// `useIsRestoring` reads the `IsRestoringProvider` context that
// `PersistedQueryClientProvider` sets while the persisted cache hydrates from
// IndexedDB. The consumer hook lives in `@tanstack/react-query` (which owns the
// context); persist-client only *produces* the value. Re-exported here so app
// code reads it within the `@arki/offline` boundary alongside the provider.
export { useIsRestoring } from '@tanstack/react-query';
