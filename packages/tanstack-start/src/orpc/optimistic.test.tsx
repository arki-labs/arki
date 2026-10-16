// @vitest-environment jsdom

import { StrictMode, createElement } from 'react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { ORPCError } from '@orpc/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Backend, Post, Reaction } from './__fixtures__/posts';
import { createBackend, deferred, servePosts } from './__fixtures__/posts';
import { keysetKey, keysetOptions } from './keyset';
import { useOptimisticMutation } from './optimistic';

let backend: Backend;
let orpc: ReturnType<typeof servePosts>['orpc'];
let queryClient: QueryClient;

const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: queryClient }, children);

const reactionKey = () => orpc.posts.reaction.queryKey({ input: { id: 'p1' } });
const postKey = () => orpc.posts.get.queryKey({ input: { id: 'p1' } });

/** Toggles the reaction on p1, the shape of Strophie's reaction button. */
function useReact() {
  return useOptimisticMutation(orpc.posts.react, {
    apply: (cache, input) => cache.update(orpc.posts.reaction, { id: input.id }, () => (input.type === undefined ? null : { type: input.type })),
  });
}

beforeEach(() => {
  backend = createBackend();
  ({ orpc } = servePosts(backend));
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

describe('useOptimisticMutation', () => {
  it('shows the edit before the server answers, then refetches the exact key on success', async () => {
    queryClient.setQueryData(reactionKey(), null);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const answer = deferred<Reaction>();
    backend.react.mockImplementationOnce(() => answer.promise);
    const { result } = renderHook(useReact, { wrapper });

    let done: Promise<unknown> = Promise.resolve();
    act(() => {
      done = result.current.mutateAsync({ id: 'p1', type: 'love' });
    });
    await waitFor(() => expect(queryClient.getQueryData(reactionKey())).toEqual({ type: 'love' }));
    expect(invalidate).not.toHaveBeenCalled();

    answer.resolve({ type: 'love' });
    await act(() => done);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: reactionKey(), exact: true });
  });

  it('rolls back to the exact snapshot on error, including a null one (Strophie bug)', async () => {
    queryClient.setQueryData(reactionKey(), null);
    backend.react.mockRejectedValueOnce(new ORPCError('INTERNAL_SERVER_ERROR'));
    const onError = vi.fn();
    const { result } = renderHook(
      () =>
        useOptimisticMutation(orpc.posts.react, {
          apply: (cache, input) => cache.update(orpc.posts.reaction, { id: input.id }, () => ({ type: input.type ?? 'like' })),
          onError,
        }),
      { wrapper },
    );

    await act(() => result.current.mutateAsync({ id: 'p1', type: 'love' }).catch(() => null));

    expect(queryClient.getQueryData(reactionKey())).toBeNull();
    expect(onError).toHaveBeenCalledWith(expect.any(ORPCError), { id: 'p1', type: 'love' });
  });

  it('skips an unloaded query (fn not called, nothing created) but still refetches its key', async () => {
    const fn = vi.fn((current: Post) => current);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(
      () => useOptimisticMutation(orpc.posts.create, { apply: cache => cache.update(orpc.posts.get, { id: 'p1' }, fn) }),
      { wrapper },
    );

    await act(() => result.current.mutateAsync({ title: 'New' }));

    expect(fn).not.toHaveBeenCalled();
    expect(queryClient.getQueryState(postKey())).toBeUndefined();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: postKey(), exact: true });
  });

  it('updateKeyset edits page 0 only and keeps cursors and pageParams', async () => {
    const args = { status: 'published' };
    backend.list.mockResolvedValueOnce({ items: [{ id: 'a', title: 'A' }], nextCursor: 'c1' });
    backend.list.mockResolvedValueOnce({ items: [{ id: 'b', title: 'B' }], nextCursor: null });
    await queryClient.fetchInfiniteQuery({ ...keysetOptions(orpc.posts.list, args), pages: 2 });
    const answer = deferred<Post>();
    backend.create.mockImplementationOnce(() => answer.promise);
    const { result } = renderHook(
      () =>
        useOptimisticMutation(orpc.posts.create, {
          apply: (cache, input) =>
            cache.updateKeyset(orpc.posts.list, args, (items, pageIndex) =>
              pageIndex === 0 ? [{ id: 'tmp', ...input }, ...items] : [...items],
            ),
        }),
      { wrapper },
    );

    act(() => {
      void result.current.mutateAsync({ title: 'New' });
    });

    await waitFor(() =>
      expect(queryClient.getQueryData(keysetKey(orpc.posts.list, args))).toEqual({
        pages: [
          { items: [{ id: 'tmp', title: 'New' }, { id: 'a', title: 'A' }], nextCursor: 'c1' },
          { items: [{ id: 'b', title: 'B' }], nextCursor: null },
        ],
        pageParams: [undefined, 'c1'],
      }),
    );
    answer.resolve({ id: 'srv_1', title: 'New' });
  });

  it('an edit that throws writes nothing and sends no request', async () => {
    queryClient.setQueryData(reactionKey(), null);
    queryClient.setQueryData(postKey(), { id: 'p1', title: 'Old' });
    const { result } = renderHook(
      () =>
        useOptimisticMutation(orpc.posts.react, {
          apply: cache => {
            cache.update(orpc.posts.get, { id: 'p1' }, current => ({ ...current, title: 'Edited' }));
            cache.update(orpc.posts.reaction, { id: 'p1' }, () => {
              throw new Error('bad edit');
            });
          },
        }),
      { wrapper },
    );

    let error: unknown;
    await act(() => result.current.mutateAsync({ id: 'p1', type: 'love' }).catch((error_: unknown) => (error = error_)));

    expect(error).toEqual(new Error('bad edit'));
    expect(queryClient.getQueryData(postKey())).toEqual({ id: 'p1', title: 'Old' });
    expect(backend.react).not.toHaveBeenCalled();
  });

  it('an async apply is refused at run time and sends no request', async () => {
    const { result } = renderHook(
      () =>
        useOptimisticMutation(orpc.posts.react, {
          // eslint-disable-next-line @typescript-eslint/no-misused-promises -- an async apply on purpose: the hook must refuse it
          apply: async cache => {
            cache.invalidate(orpc.posts);
            await Promise.resolve();
          },
        }),
      { wrapper },
    );

    let error: unknown;
    await act(() => result.current.mutateAsync({ id: 'p1' }).catch((error_: unknown) => (error = error_)));

    expect(error).toBeInstanceOf(TypeError);
    expect(backend.react).not.toHaveBeenCalled();
  });

  it('two overlapping calls of one procedure refetch once, after the second settles', async () => {
    queryClient.setQueryData(reactionKey(), null);
    const first = deferred<Reaction>();
    const second = deferred<Reaction>();
    backend.react.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(useReact, { wrapper });

    let a: Promise<unknown> = Promise.resolve();
    let b: Promise<unknown> = Promise.resolve();
    act(() => {
      a = result.current.mutateAsync({ id: 'p1', type: 'like' });
      b = result.current.mutateAsync({ id: 'p1', type: 'love' });
    });
    await waitFor(() => expect(backend.react).toHaveBeenCalledTimes(2));
    first.resolve({ type: 'like' });
    await act(() => a);
    expect(invalidate).not.toHaveBeenCalled();

    second.resolve({ type: 'love' });
    await act(() => b);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('when the first call fails while the second is in flight, its rollback is skipped (the cache is not its value)', async () => {
    queryClient.setQueryData(reactionKey(), null);
    const first = deferred<Reaction>();
    backend.react.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => deferred<Reaction>().promise);
    const { result } = renderHook(useReact, { wrapper });

    let a: Promise<unknown> = Promise.resolve();
    act(() => {
      a = result.current.mutateAsync({ id: 'p1', type: 'like' }).catch(() => null);
      void result.current.mutateAsync({ id: 'p1', type: 'love' });
    });
    await waitFor(() => expect(queryClient.getQueryData(reactionKey())).toEqual({ type: 'love' }));
    first.reject(new ORPCError('INTERNAL_SERVER_ERROR'));
    await act(() => a);

    expect(queryClient.getQueryData(reactionKey())).toEqual({ type: 'love' });
  });

  it('invalidate(orpc.posts) refetches every posts.* query when it settles', async () => {
    queryClient.setQueryData(postKey(), { id: 'p1', title: 'Old' });
    queryClient.setQueryData(reactionKey(), null);
    const { result } = renderHook(
      () => useOptimisticMutation(orpc.posts.create, { apply: cache => cache.invalidate(orpc.posts) }),
      { wrapper },
    );

    await act(() => result.current.mutateAsync({ title: 'New' }));

    expect(queryClient.getQueryState(postKey())?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(reactionKey())?.isInvalidated).toBe(true);
  });

  it('in development, editing the snapshot in place throws instead of corrupting the cache', async () => {
    queryClient.setQueryData(postKey(), { id: 'p1', title: 'Old' });
    const { result } = renderHook(
      () =>
        useOptimisticMutation(orpc.posts.create, {
          apply: cache =>
            cache.update(orpc.posts.get, { id: 'p1' }, current => {
              current.title = 'Mutated';
              return current;
            }),
        }),
      { wrapper },
    );

    let error: unknown;
    await act(() => result.current.mutateAsync({ title: 'New' }).catch((error_: unknown) => (error = error_)));

    expect(error).toBeInstanceOf(TypeError);
    expect(queryClient.getQueryData(postKey())).toEqual({ id: 'p1', title: 'Old' });
  });

  it('sends one request under React Strict Mode', async () => {
    const strictWrapper = ({ children }: { children: ReactNode }) => createElement(StrictMode, null, wrapper({ children }));
    const { result } = renderHook(useReact, { wrapper: strictWrapper });
    await act(() => result.current.mutateAsync({ id: 'p1', type: 'love' }));
    expect(backend.react).toHaveBeenCalledTimes(1);
  });
});
