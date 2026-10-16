/**
 * `useKeysetQuery`: a keyset-paged list over the `pageInput` / `page`
 * contract of `@arki/contracts`, as `items`, `status` and `loadMore(n)`.
 *
 * Takes any oRPC `ProcedureUtils` — contract-built (`createOrpcUtils`),
 * router-built or `createTanstackQueryUtils` — whose output is `Page<T>`
 * and whose input has a `cursor`. Types come from the procedure; nothing is
 * written at the call site.
 */
import { useCallback, useMemo, useRef } from 'react';
import type { RefObject } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { DataTag, InfiniteData, QueryKey, UseInfiniteQueryResult } from '@tanstack/react-query';
import type { ProcedureUtils } from '@orpc/tanstack-query';

import type { Page } from '@arki/contracts';

/**
 * The input of a keyset list: an optional cursor and page size, plus the
 * list's own filters. The caller passes it without the cursor; `limit`
 * stays — it is the first page's size and part of the query key.
 */
export type PagedInput = { readonly cursor?: string | undefined; readonly limit?: number | undefined };

export type KeysetStatus = 'idle' | 'loadingFirstPage' | 'canLoadMore' | 'loadingMore' | 'exhausted' | 'error';

export type KeysetOptions = {
  /** `false` keeps the list `idle`: no request. */
  readonly enabled?: boolean;
  readonly staleTime?: number;
};

/**
 * The client context the hooks accept: optional, as oRPC's default. The hooks
 * send no per-call context, so utils whose client REQUIRES a context are a
 * compile error here — call their own `infiniteOptions` / `mutationOptions`.
 */
export type OptionalContext = Record<never, never>;

type KeysetData<TPage> = InfiniteData<TPage, string | undefined>;

export type KeysetResult<TItem, TError, TPage extends Page<TItem> = Page<TItem>> = {
  /** Every loaded row, in server order. */
  readonly items: readonly TItem[];
  readonly status: KeysetStatus;
  readonly error: TError | null;
  /** A background refetch is running (not the first load, not `loadMore`). */
  readonly isFetching: boolean;
  /**
   * Fetch one more page of `count` rows (default: the args' limit, else the
   * contract default). A no-op unless `status` is `'canLoadMore'`. Resolves
   * when the page lands; never rejects — a failure shows as `status: 'error'`.
   */
  readonly loadMore: (count?: number) => Promise<void>;
  /** Escape hatch: the underlying TanStack infinite query. */
  readonly query: UseInfiniteQueryResult<KeysetData<TPage>, TError>;
};

/**
 * Utils of a keyset list: output `Page<TItem>`, plus any extra fields the
 * procedure returns (`hasMore`, totals). oRPC's utils are invariant in their
 * output, so the extra fields ride in `TOutput` and the page part is checked.
 */
export type KeysetUtils<TInput extends PagedInput, TOutput, TItem, TError> = ProcedureUtils<
  OptionalContext,
  TInput,
  TOutput & Page<TItem>,
  TError
>;

/**
 * The page input for a cursor. The first page sends `args` as given: the
 * query key is derived from it, so it never changes when `loadMore` picks a
 * new size. Later pages add the cursor and, when set, the `loadMore` size.
 */
function pageInputFor<TInput extends PagedInput>(args: TInput, nextLimit: RefObject<number | undefined>) {
  return (cursor: string | undefined): TInput => {
    if (cursor === undefined) return args;
    const limit = nextLimit.current;
    return limit === undefined ? { ...args, cursor } : { ...args, cursor, limit };
  };
}

function infiniteOptionsWith<TInput extends PagedInput, TOutput, TItem, TError>(
  utils: KeysetUtils<TInput, TOutput, TItem, TError>,
  args: TInput,
  options: KeysetOptions,
  nextLimit: RefObject<number | undefined>,
) {
  return utils.infiniteOptions({
    input: pageInputFor(args, nextLimit),
    initialPageParam: undefined,
    getNextPageParam: (last: TOutput & Page<TItem>) => last.nextCursor ?? undefined,
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
    ...(options.staleTime === undefined ? {} : { staleTime: options.staleTime }),
  });
}

/**
 * Infinite-query options for a keyset list. For loaders:
 * `queryClient.infiniteQuery({ ...keysetOptions(orpc.posts.list, args), staleTime: 'static' })`.
 */
export function keysetOptions<TInput extends PagedInput, TOutput, TItem, TError>(
  utils: KeysetUtils<TInput, TOutput, TItem, TError>,
  args: NoInfer<TInput>,
  options: KeysetOptions = {},
) {
  return infiniteOptionsWith(utils, args, options, { current: undefined });
}

/** The exact key `useKeysetQuery` registers for these args. */
export function keysetKey<TInput extends PagedInput, TOutput, TItem, TError>(
  utils: KeysetUtils<TInput, TOutput, TItem, TError>,
  args: NoInfer<TInput>,
): DataTag<QueryKey, KeysetData<TOutput & Page<TItem>>, TError> {
  return utils.infiniteKey({ input: pageInputFor(args, { current: undefined }), initialPageParam: undefined });
}

function statusOf(query: UseInfiniteQueryResult<unknown, unknown>, enabled: boolean): KeysetStatus {
  if (query.data === undefined) {
    if (query.isError) return 'error';
    if (query.isFetching) return 'loadingFirstPage';
    return enabled ? 'loadingFirstPage' : 'idle';
  }
  if (query.isFetchingNextPage) return 'loadingMore';
  if (query.isFetchNextPageError) return 'error';
  return query.hasNextPage ? 'canLoadMore' : 'exhausted';
}

/**
 * A keyset-paged list: `items`, `status` and `loadMore(n)`.
 *
 * @example
 * ```tsx
 * const { items, status, loadMore } = useKeysetQuery(orpc.posts.list, { status: 'published' });
 * {status === 'canLoadMore' && <button onClick={() => void loadMore(50)}>More</button>}
 * ```
 */
export function useKeysetQuery<TInput extends PagedInput, TOutput, TItem, TError>(
  utils: KeysetUtils<TInput, TOutput, TItem, TError>,
  args: NoInfer<TInput>,
  options: KeysetOptions = {},
): KeysetResult<TItem, TError, TOutput & Page<TItem>> {
  const nextLimit = useRef<number | undefined>(undefined);
  const query = useInfiniteQuery(infiniteOptionsWith(utils, args, options, nextLimit));
  const status = statusOf(query, options.enabled !== false);
  const { fetchNextPage } = query;

  const pages = query.data?.pages;
  const items = useMemo(() => pages?.flatMap(page => page.items) ?? [], [pages]);

  const loadMore = useCallback(
    async (count?: number) => {
      if (status !== 'canLoadMore') return;
      nextLimit.current = count;
      // `cancelRefetch: false`: a second call while this page is in flight (a
      // double click in one tick) joins it instead of sending another request.
      await fetchNextPage({ cancelRefetch: false });
    },
    [status, fetchNextPage],
  );

  return {
    items,
    status,
    error: query.error,
    isFetching: query.isFetching && !query.isFetchingNextPage && query.data !== undefined,
    loadMore,
    query,
  };
}
