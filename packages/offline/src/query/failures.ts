import { defineFailure } from '@arki/failure';

/**
 * The persisted query cache could not be written to IndexedDB (storage full, private browsing, a blocked
 * database, or a cache that cannot be serialized). The in-memory cache is unchanged.
 * @fix Free browser storage or accept an in-memory-only cache for this session; the next write tries again.
 * @verify bun run test -- __tests__/query/persist-now.test.ts
 */
export const QueryCachePersistFailed = /* @__PURE__ */ defineFailure('offline.query_cache_persist_failed', {
  status: 507,
  message: 'The query cache could not be written to local storage.',
  remediation: 'Free browser storage or accept an in-memory-only cache for this session; the next write tries again.',
});
