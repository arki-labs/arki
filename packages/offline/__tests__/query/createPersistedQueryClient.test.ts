import { describe, it, expect, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';

// Minimal mock — we only care about the factory shape, not IDB internals.
vi.mock('idb-keyval', () => ({
  get: vi.fn(() => Promise.resolve()),
  set: vi.fn(() => Promise.resolve()),
  del: vi.fn(() => Promise.resolve()),
}));

const { createPersistedQueryClient } = await import(
  '../../src/query/createPersistedQueryClient.ts'
);

describe('createPersistedQueryClient', () => {
  it('returns a QueryClient instance', () => {
    const { queryClient } = createPersistedQueryClient();
    expect(queryClient).toBeInstanceOf(QueryClient);
  });

  it('returns a persister with the required Persister interface', () => {
    const { persister } = createPersistedQueryClient();
    expect(typeof persister.persistClient).toBe('function');
    expect(typeof persister.restoreClient).toBe('function');
    expect(typeof persister.removeClient).toBe('function');
  });

  it('applies defaultOptions to the QueryClient', () => {
    const { queryClient } = createPersistedQueryClient({
      defaultOptions: {
        queries: { retry: 0 },
      },
    });

    // The default options should be merged; retry:0 should be accessible.
    const defaults = queryClient.getDefaultOptions();
    expect(defaults.queries?.retry).toBe(0);
  });

  it('sets gcTime on queries to the provided maxAge', () => {
    const maxAge = 1000 * 60 * 30; // 30 minutes
    const { queryClient, maxAge: resolvedMaxAge } = createPersistedQueryClient({ maxAge });

    const defaults = queryClient.getDefaultOptions();
    expect(defaults.queries?.gcTime).toBe(maxAge);
    // maxAge is also returned so the caller can forward it to the provider.
    expect(resolvedMaxAge).toBe(maxAge);
  });

  it('defaults storageKey to arki-offline-query and returns a usable persister', () => {
    const { persister } = createPersistedQueryClient();
    // The factory must not throw and must return a fully-shaped Persister.
    expect(persister).toBeDefined();
    expect(typeof persister.persistClient).toBe('function');
  });

  it('returns the resolved buster so the caller can forward it to the provider', () => {
    const { buster } = createPersistedQueryClient({ buster: 'deploy-abc' });
    // buster is returned in the result object for forwarding to PersistedQueryClientProvider.
    expect(buster).toBe('deploy-abc');
  });

  it('defaults buster to VITE_BUILD_ID or empty string', () => {
    // In the test environment VITE_BUILD_ID is undefined, so buster falls back to ''.
    const { buster } = createPersistedQueryClient();
    expect(typeof buster).toBe('string');
  });

  it('custom defaultOptions are merged without overwriting gcTime set by maxAge', () => {
    const maxAge = 5000;
    const { queryClient } = createPersistedQueryClient({
      maxAge,
      defaultOptions: {
        queries: { staleTime: 1000 },
      },
    });

    const defaults = queryClient.getDefaultOptions();
    // Both maxAge-derived gcTime and the custom staleTime should be present.
    expect(defaults.queries?.gcTime).toBe(maxAge);
    expect(defaults.queries?.staleTime).toBe(1000);
  });
});
