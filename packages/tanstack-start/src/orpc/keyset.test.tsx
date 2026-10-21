// @vitest-environment jsdom

import { createElement } from 'react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { ORPCError } from '@orpc/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Backend, ListInput, PostPage } from './__fixtures__/posts';
import { createBackend, deferred, servePosts } from './__fixtures__/posts';
import { keysetKey, keysetOptions, useKeysetQuery } from './keyset';

let backend: Backend;
let orpc: ReturnType<typeof servePosts>['orpc'];
let queryClient: QueryClient;

const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: queryClient }, children);

/** Pages keyed by cursor: `first` → `c1` → `c2` → end. */
function pagedBackend(input: ListInput): Promise<PostPage> {
  const at = input.cursor ?? 'first';
  const next: Record<string, string | null> = { first: 'c1', c1: 'c2', c2: null };
  return Promise.resolve({ items: [{ id: `${at}-${String(input.limit)}`, title: at }], nextCursor: next[at] ?? null });
}

beforeEach(() => {
  backend = createBackend();
  backend.list.mockImplementation(pagedBackend);
  ({ orpc } = servePosts(backend));
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

describe('useKeysetQuery', () => {
  it('walks loadingFirstPage → canLoadMore → loadingMore → exhausted, items in server order', async () => {
    const { result } = renderHook(() => useKeysetQuery(orpc.posts.list, { status: 'published' }), { wrapper });
    expect(result.current.status).toBe('loadingFirstPage');
    await waitFor(() => expect(result.current.status).toBe('canLoadMore'));
    expect(result.current.items.map(item => item.title)).toEqual(['first']);

    const page2 = deferred<PostPage>();
    backend.list.mockImplementationOnce(() => page2.promise);
    let loading: Promise<void> = Promise.resolve();
    act(() => {
      loading = result.current.loadMore();
    });
    await waitFor(() => expect(result.current.status).toBe('loadingMore'));
    page2.resolve({ items: [{ id: 'c1', title: 'c1' }], nextCursor: 'c2' });
    await act(() => loading);
    await waitFor(() => expect(result.current.status).toBe('canLoadMore'));
    await act(() => result.current.loadMore());

    await waitFor(() => expect(result.current.status).toBe('exhausted'));
    expect(result.current.items.map(item => item.title)).toEqual(['first', 'c1', 'c2']);
  });

  it('loadMore() sends the last nextCursor; loadMore(50) sends limit 50 for that page only', async () => {
    const { result } = renderHook(() => useKeysetQuery(orpc.posts.list, { status: 'draft', limit: 5 }), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('canLoadMore'));
    await act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    await act(() => result.current.loadMore(50));
    await waitFor(() => expect(result.current.items).toHaveLength(3));

    expect(backend.list.mock.calls.map(([input]) => input)).toEqual([
      { status: 'draft', limit: 5 },
      { status: 'draft', limit: 5, cursor: 'c1' },
      { status: 'draft', limit: 50, cursor: 'c2' },
    ]);
  });

  it('a double click sends one request; loadMore while loadingMore resolves without a call', async () => {
    const { result } = renderHook(() => useKeysetQuery(orpc.posts.list, { status: 'published' }), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('canLoadMore'));
    const slow = deferred<PostPage>();
    backend.list.mockImplementationOnce(() => slow.promise);

    let first: Promise<void> = Promise.resolve();
    let second: Promise<void> = Promise.resolve();
    act(() => {
      first = result.current.loadMore();
      second = result.current.loadMore();
    });
    await waitFor(() => expect(result.current.status).toBe('loadingMore'));
    await act(() => result.current.loadMore());
    slow.resolve({ items: [{ id: 'x', title: 'c1' }], nextCursor: null });
    await act(() => Promise.all([first, second]));

    await waitFor(() => expect(result.current.status).toBe('exhausted'));
    expect(backend.list).toHaveBeenCalledTimes(2);
  });

  it('an empty first page with nextCursor null is exhausted, not loading', async () => {
    backend.list.mockResolvedValueOnce({ items: [], nextCursor: null });
    const { result } = renderHook(() => useKeysetQuery(orpc.posts.list, { status: 'none' }), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('exhausted'));
    expect(result.current.items).toEqual([]);
    await act(() => result.current.loadMore());
    expect(backend.list).toHaveBeenCalledTimes(1);
  });

  it('an error on page 2 shows as error and keeps page 1; loadMore never rejects', async () => {
    const { result } = renderHook(() => useKeysetQuery(orpc.posts.list, { status: 'published' }), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('canLoadMore'));
    backend.list.mockRejectedValueOnce(new ORPCError('INTERNAL_SERVER_ERROR'));

    await act(() => result.current.loadMore());

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBeInstanceOf(ORPCError);
    expect(result.current.items.map(item => item.title)).toEqual(['first']);
  });

  it('a first-page error is error, with no items', async () => {
    backend.list.mockRejectedValueOnce(new ORPCError('INTERNAL_SERVER_ERROR'));
    const { result } = renderHook(() => useKeysetQuery(orpc.posts.list, { status: 'published' }), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.items).toEqual([]);
  });

  it('when args change mid-request, the late answer lands only under the old key', async () => {
    const slow = deferred<PostPage>();
    backend.list.mockImplementationOnce(() => slow.promise);
    const { result, rerender } = renderHook(({ status }) => useKeysetQuery(orpc.posts.list, { status }), {
      wrapper,
      initialProps: { status: 'old' },
    });
    rerender({ status: 'new' });
    await waitFor(() => expect(result.current.items.map(item => item.id)).toEqual(['first-2']));

    slow.resolve({ items: [{ id: 'late', title: 'late' }], nextCursor: null });
    await act(() => slow.promise);
    // TanStack drops the old request when its last observer leaves (oRPC consumes the abort signal);
    // either way the late answer never reaches the new list.
    expect(result.current.items.map(item => item.id)).toEqual(['first-2']);
    expect(queryClient.getQueryData(keysetKey(orpc.posts.list, { status: 'new' }))?.pages.flatMap(p => p.items)).toEqual([
      { id: 'first-2', title: 'first' },
    ]);
  });

  it('enabled: false is idle and sends nothing', () => {
    const { result } = renderHook(() => useKeysetQuery(orpc.posts.list, { status: 'x' }, { enabled: false }), { wrapper });
    expect(result.current.status).toBe('idle');
    expect(backend.list).not.toHaveBeenCalled();
  });

  it('keysetKey is the key the hook registers, and keysetOptions primes it for a loader (one fetch)', async () => {
    const args = { status: 'published', limit: 3 };
    await queryClient.infiniteQuery({ ...keysetOptions(orpc.posts.list, args), staleTime: 'static' });
    expect(queryClient.getQueryData(keysetKey(orpc.posts.list, args))?.pages).toHaveLength(1);

    const { result } = renderHook(() => useKeysetQuery(orpc.posts.list, args), { wrapper });
    expect(result.current.status).toBe('canLoadMore');
    expect(backend.list).toHaveBeenCalledTimes(1);
  });

  it('unmounting during a fetch logs no React warning', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => null);
    const slow = deferred<PostPage>();
    backend.list.mockImplementationOnce(() => slow.promise);
    const { unmount } = renderHook(() => useKeysetQuery(orpc.posts.list, { status: 'x' }), { wrapper });
    unmount();
    slow.resolve({ items: [], nextCursor: null });
    await act(() => slow.promise);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
