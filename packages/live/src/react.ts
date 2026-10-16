/**
 * `useLiveQuery`: the typed core of the `@arki/live/react` hook. It takes the
 * query options oRPC builds (`orpc.posts.list.queryOptions({ input })`), so
 * input, output, error and `select` types all come from oRPC and TanStack and
 * nothing is restated. The provider (one stream per tab, invalidation by
 * path, the dev-mode manifest check) comes with the `@arki/live/react` entry.
 *
 * Why options and not `(utils, input, options)`: a generic wrapper over
 * `ProcedureUtils<C, I, O, E>` cannot call `utils.queryOptions(...)` without a
 * cast — oRPC's `MaybeOptionalOptions<U & QueryOptionsIn<C, I, …>>` stays a
 * deferred conditional while `C` and `I` are generic. `react.types.test.ts`
 * keeps that counter-example.
 */
import type { DefaultError, QueryKey, UseQueryOptions, UseQueryResult } from '@tanstack/react-query';
import { useQuery } from '@tanstack/react-query';

/** TanStack's own generics and defaults, so `data` is the output unless `select` maps it. */
export function useLiveQuery<
  TQueryFnData = unknown,
  TError = DefaultError,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
>(options: UseQueryOptions<TQueryFnData, TError, TData, TQueryKey>): UseQueryResult<TData, TError> {
  return useQuery(options);
}
