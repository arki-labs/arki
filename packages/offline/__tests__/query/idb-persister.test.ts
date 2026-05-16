import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory store that replaces real IndexedDB in unit tests.
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

// Import AFTER the mock is registered so the module picks up the mock.
const { createIdbPersister } = await import(
  '../../src/query/idb-persister.ts'
);

describe('createIdbPersister', () => {
  beforeEach(() => {
    // Clear the in-memory store and reset call history between tests.
    for (const k of Object.keys(store)) delete store[k];
    vi.clearAllMocks();
  });

  it('round-trips a string value via setItem / getItem', async () => {
    const persister = createIdbPersister({ storageKey: 'test-key' });

    const payload = JSON.stringify({ timestamp: 1, buster: '', clientState: {} });
    await persister.persistClient({ timestamp: 1, buster: '', clientState: { queries: [], mutations: [] } });

    // The stored value is the JSON-serialised PersistedClient.
    expect(store['test-key']).toBeDefined();
    // Restoring should give back the same shape.
    const restored = await persister.restoreClient();
    expect(restored).toBeDefined();
    expect(restored?.buster).toBe('');
    expect(restored?.timestamp).toBe(1);
    void payload; // referenced only for clarity
  });

  it('removeClient clears the persisted entry', async () => {
    const persister = createIdbPersister({ storageKey: 'clear-test' });

    await persister.persistClient({ timestamp: 2, buster: 'v1', clientState: { queries: [], mutations: [] } });
    expect(store['clear-test']).toBeDefined();

    await persister.removeClient();
    expect(store['clear-test']).toBeUndefined();
  });

  it('uses the default storageKey when none is provided', async () => {
    const persister = createIdbPersister();

    await persister.persistClient({ timestamp: 3, buster: '', clientState: { queries: [], mutations: [] } });
    expect(store['arki-offline-query']).toBeDefined();
  });

  it('isolates data between different storageKeys', async () => {
    const persisterA = createIdbPersister({ storageKey: 'ns-a' });
    const persisterB = createIdbPersister({ storageKey: 'ns-b' });

    await persisterA.persistClient({ timestamp: 10, buster: 'a', clientState: { queries: [], mutations: [] } });
    await persisterB.persistClient({ timestamp: 20, buster: 'b', clientState: { queries: [], mutations: [] } });

    const restoredA = await persisterA.restoreClient();
    const restoredB = await persisterB.restoreClient();

    expect(restoredA?.buster).toBe('a');
    expect(restoredB?.buster).toBe('b');
    expect(restoredA?.timestamp).not.toBe(restoredB?.timestamp);
  });
});
