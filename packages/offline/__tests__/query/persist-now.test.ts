import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    await persistNow();

    queryClient.removeQueries({ queryKey: ['item', 'b'] });
    await persistNow();

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
    await persistNow();

    expect((await persister.restoreClient())?.buster).toBe(buster);
    expect(buster).toBe('build-7');
  });
});
