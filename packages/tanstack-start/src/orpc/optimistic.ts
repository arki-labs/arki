/**
 * `useOptimisticMutation`: a mutation whose cache edits show at once, roll
 * back on error and refetch when the last concurrent call settles.
 *
 * `apply(cache, input)` only RECORDS typed edits; the mutation runs them:
 *
 *   1. cancel the touched queries, read every snapshot, compute EVERY
 *      replacement — a throwing edit writes nothing and sends no request;
 *   2. write them all;
 *   3. on error, restore each snapshot in reverse — only where the cache
 *      still holds the value this mutation wrote;
 *   4. when the last in-flight mutation of this procedure settles,
 *      invalidate every query any of them touched.
 *
 * Rollback is local cache only: it never reverses a database write, a job or
 * an email. Concurrent edits to one key are last-writer-wins until the refetch.
 */
import { hashKey, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  DataTag,
  InfiniteData,
  QueryClient,
  QueryKey,
  UseMutationOptions,
  UseMutationResult,
} from '@tanstack/react-query';
import type { GeneralUtils, ProcedureUtils } from '@orpc/tanstack-query';

import type { Page } from '@arki/contracts';

import type { KeysetUtils, OptionalContext, PagedInput } from './keyset';
import { keysetKey } from './keyset';

/** Typed cache edits. `apply` records them; the mutation executes them. */
export type Cache = {
  /** Replace one query's data. `fn` runs only if the query is in the cache. */
  update<TInput, TOutput, TError>(
    utils: ProcedureUtils<OptionalContext, TInput, TOutput, TError>,
    input: NoInfer<TInput>,
    fn: (current: TOutput) => NoInfer<TOutput>,
  ): void;
  /** Edit the loaded pages of a keyset list, page by page. Cursors and pageParams are kept. */
  updateKeyset<TInput extends PagedInput, TOutput, TItem, TError>(
    utils: KeysetUtils<TInput, TOutput, TItem, TError>,
    args: NoInfer<TInput>,
    fn: (items: readonly TItem[], pageIndex: number) => NoInfer<TItem>[],
  ): void;
  /** Refetch everything under a utils node (partial key) when the mutation settles. */
  invalidate(utils: GeneralUtils<unknown>): void;
};

export type OptimisticOptions<TInput, TOutput, TError> = {
  readonly apply: (cache: Cache, input: TInput) => void;
  readonly onSuccess?: (output: TOutput, input: TInput) => void;
  readonly onError?: (error: TError, input: TInput) => void;
};

/** One edit as written: restored on error only if the cache still holds `written`. */
type WrittenEdit = { readonly queryKey: QueryKey; readonly previous: unknown; readonly written: unknown };

/** A query to refetch when the mutation settles: an edited key exactly, an `invalidate` node by prefix. */
type Refetch = { readonly queryKey: QueryKey; readonly exact: boolean };

/** Opaque to callers: the edits this mutation wrote, and the queries to refetch when it settles. */
export type OptimisticContext = { readonly '~edits': readonly WrittenEdit[]; readonly '~refetch': readonly Refetch[] };

/** A recorded edit: `prepare` reads the snapshot and computes the replacement; `write` stores it. */
type RecordedEdit = {
  readonly queryKey: QueryKey;
  readonly prepare: () => PreparedEdit | undefined;
};
type PreparedEdit = { readonly write: () => WrittenEdit };

/** In development, a snapshot handed to an edit is frozen, so mutating it in place throws. */
function frozenInDev<T>(value: T): T {
  // eslint-disable-next-line turbo/no-undeclared-env-vars -- Vite's build-mode flag, not an environment variable
  if (import.meta.env.DEV && typeof value === 'object' && value !== null) Object.freeze(value);
  return value;
}

function edit<T, TError>(
  queryClient: QueryClient,
  queryKey: DataTag<QueryKey, T, TError>,
  replace: (current: T) => T,
): RecordedEdit {
  return {
    queryKey,
    prepare: (): PreparedEdit | undefined => {
      const previous = queryClient.getQueryData(queryKey);
      // Not loaded: nothing to edit (and nothing to create). The key is still refetched.
      if (previous === undefined) return;
      const next = replace(previous);
      return {
        write: () => {
          queryClient.setQueryData(queryKey, next);
          return { queryKey, previous, written: queryClient.getQueryData(queryKey) };
        },
      };
    },
  };
}

function editKeyset<TPage extends Page<TItem>, TItem, TError>(
  queryClient: QueryClient,
  queryKey: DataTag<QueryKey, InfiniteData<TPage, string | undefined>, TError>,
  fn: (items: readonly TItem[], pageIndex: number) => TItem[],
): RecordedEdit {
  return edit(queryClient, queryKey, data => ({
    ...data,
    pages: data.pages.map((page, index) => ({ ...page, items: fn(frozenInDev(page.items), index) })),
  }));
}

/** Keys waiting for the last in-flight mutation of a procedure, per QueryClient and mutation key. */
const pendingRefetch = new WeakMap<QueryClient, Map<string, Refetch[]>>();

function isThenable(value: unknown): boolean {
  return (typeof value === 'object' || typeof value === 'function') && value !== null && 'then' in value;
}

/**
 * Mutation options with optimistic edits. `useOptimisticMutation` is this
 * plus `useQueryClient`; use this one outside React or to add options.
 */
export function optimisticMutationOptions<TInput, TOutput, TError>(
  queryClient: QueryClient,
  utils: ProcedureUtils<OptionalContext, TInput, TOutput, TError>,
  options: OptimisticOptions<TInput, TOutput, TError>,
): UseMutationOptions<TOutput, TError, TInput, OptimisticContext> {
  const mutationKey = utils.mutationKey();

  return {
    ...utils.mutationOptions(),

    onMutate: async input => {
      const edits: RecordedEdit[] = [];
      const partialKeys: QueryKey[] = [];
      const cache: Cache = {
        update: (target, targetInput, fn) =>
          edits.push(edit(queryClient, target.queryKey({ input: targetInput }), current => fn(frozenInDev(current)))),
        updateKeyset: (target, args, fn) => edits.push(editKeyset(queryClient, keysetKey(target, args), fn)),
        invalidate: target => partialKeys.push(target.key()),
      };

      const applied: unknown = options.apply(cache, input);
      if (isThenable(applied)) {
        throw new TypeError('useOptimisticMutation: `apply` must be synchronous; it only records cache edits.');
      }

      for (const recorded of edits) await queryClient.cancelQueries({ queryKey: recorded.queryKey, exact: true });
      // Compute every replacement before writing any: a throwing edit leaves the cache untouched.
      const prepared = edits.map(recorded => recorded.prepare());
      const written = prepared.flatMap(step => (step === undefined ? [] : [step.write()]));

      const refetch: Refetch[] = [
        ...edits.map(recorded => ({ queryKey: recorded.queryKey, exact: true })),
        ...partialKeys.map(queryKey => ({ queryKey, exact: false })),
      ];
      return { '~edits': written, '~refetch': refetch };
    },

    onError: (error, input, context) => {
      const written = context?.['~edits'] ?? [];
      for (let index = written.length - 1; index >= 0; index--) {
        const done = written[index];
        // Someone else replaced it since (another mutation, a refetch): keep theirs; the settle step refetches.
        if (done !== undefined && queryClient.getQueryData(done.queryKey) === done.written) {
          queryClient.setQueryData(done.queryKey, done.previous);
        }
      }
      options.onError?.(error, input);
    },

    onSuccess: (output, input) => {
      options.onSuccess?.(output, input);
    },

    onSettled: (_output, _error, _input, context) => {
      const byKey = pendingRefetch.get(queryClient) ?? new Map<string, Refetch[]>();
      pendingRefetch.set(queryClient, byKey);
      const hash = hashKey(mutationKey);
      const keys = [...(byKey.get(hash) ?? []), ...(context?.['~refetch'] ?? [])];
      // The settling mutation still counts as pending here, so 1 means "this is the last one".
      if (queryClient.isMutating({ mutationKey }) > 1) {
        byKey.set(hash, keys);
        return;
      }
      byKey.delete(hash);
      // Overlapping calls often touch the same query: refetch each one once.
      const unique = new Map(keys.map(refetch => [`${String(refetch.exact)}:${hashKey(refetch.queryKey)}`, refetch]));
      for (const { queryKey, exact } of unique.values()) void queryClient.invalidateQueries({ queryKey, exact });
    },
  };
}

/**
 * A mutation with typed optimistic cache edits, guarded rollback and a
 * refetch when the last concurrent call settles.
 *
 * @example
 * ```tsx
 * const create = useOptimisticMutation(orpc.posts.create, {
 *   apply: (cache, input) =>
 *     cache.updateKeyset(orpc.posts.list, { status: 'published' }, (items, pageIndex) =>
 *       pageIndex === 0 ? [{ ...input, id: tempId() }, ...items] : items),
 * });
 * ```
 */
export function useOptimisticMutation<TInput, TOutput, TError>(
  utils: ProcedureUtils<OptionalContext, TInput, TOutput, TError>,
  options: OptimisticOptions<TInput, TOutput, TError>,
): UseMutationResult<TOutput, TError, TInput, OptimisticContext> {
  const queryClient = useQueryClient();
  return useMutation(optimisticMutationOptions(queryClient, utils, options), queryClient);
}
