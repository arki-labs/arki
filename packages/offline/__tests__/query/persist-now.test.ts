import { beforeEach, describe, expect, it, vi } from 'vitest';

import { orThrow } from '@arki/failure';

// Stand-in for IndexedDB: real IndexedDB needs a browser, and the Avocabo US-23 e2e covers it in Chrome.
const store: Record<string, string> = {};

vi.mock('idb-keyval', () => ({
  get: vi.fn((key: string) => Promise.resolve(store[key])),
  set: vi.fn((key: string, value: string) => {
    store[key] = value;
    return Promise.resolve();
  }),
  del: vi.fn((key: string) => {
    delete store[key];
    return Promise.resolve();
  }),
}));

const idb = await import('idb-keyval');
const { QueryCachePersistFailed } = await import('../../src/query/failures.ts');
const { createPersistedQueryClient } = await import('../../src/query/createPersistedQueryClient.ts');

describe('persistNow', () => {
  beforeEach(() => {
    for (const key of Object.keys(store)) delete store[key];
  });

  // The throttled persister writes at most once a second and never says when it is done. A page that
  // reloads right after a delete would restore the snapshot from before the delete.
  it('has written a removed query out of the stored cache by the time it resolves', async () => {
    const { queryClient, persister, persistNow } = createPersistedQueryClient({ storageKey: 'now-test' });
    queryClient.setQueryData(['item', 'a'], { title: 'Kept' });
    queryClient.setQueryData(['item', 'b'], { title: 'Deleted' });
    orThrow(await persistNow());

    queryClient.removeQueries({ queryKey: ['item', 'b'] });
    orThrow(await persistNow());

    const restored = await persister.restoreClient();
    const keys = restored?.clientState.queries.map(query => query.queryKey);
    expect(keys).toEqual([['item', 'a']]);
  });

  it('stores the cache under the same busting string the provider checks on restore', async () => {
    const { queryClient, persister, persistNow, buster } = createPersistedQueryClient({
      storageKey: 'buster-test',
      buster: 'build-7',
    });
    queryClient.setQueryData(['item', 'a'], { title: 'Kept' });
    orThrow(await persistNow());

    const restored = await persister.restoreClient();
    expect(restored?.buster).toBe(buster);
    expect(buster).toBe('build-7');
  });

  // IndexedDB refuses a write when the browser is out of space. The page must hear about it as a value,
  // not as an unhandled rejection of a raw DOMException.
  it('resolves offline.query_cache_persist_failed when IndexedDB refuses the write (quota)', async () => {
    const { queryClient, persistNow } = createPersistedQueryClient({ storageKey: 'quota-test' });
    queryClient.setQueryData(['item', 'a'], { title: 'Kept' });
    vi.mocked(idb.set).mockRejectedValueOnce(new DOMException('full', 'QuotaExceededError'));

    const outcome = await persistNow();

    expect(QueryCachePersistFailed.is(outcome)).toBe(true);
  });

  // A stored cache is outside data: other builds, other tabs and bad writes can leave anything there.
  it('restores nothing from a stored value that is not a persisted client, and drops it', async () => {
    const { persister } = createPersistedQueryClient({ storageKey: 'corrupt-test' });
    store['corrupt-test'] = JSON.stringify({ json: { timestamp: 'yesterday', clientState: 5 } });

    await expect(persister.restoreClient()).resolves.toBeUndefined();
    expect(store['corrupt-test']).toBeUndefined();
  });
});
