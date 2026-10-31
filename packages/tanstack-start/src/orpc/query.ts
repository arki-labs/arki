/**
 * `@arki/tanstack-start/orpc/query`: typed React hooks over oRPC query utils.
 *
 * - `useKeysetQuery` — a keyset-paged list as `items`, `status`, `loadMore(n)`.
 * - `useOptimisticMutation` — typed optimistic cache edits with guarded
 *   rollback and a refetch when the last concurrent call settles.
 *
 * Both take any oRPC `ProcedureUtils`; types come from the procedure.
 */
export type { KeysetOptions, KeysetResult, KeysetStatus, KeysetUtils, OptionalContext, PagedInput } from './keyset.js';
export { keysetKey, keysetOptions, useKeysetQuery } from './keyset.js';
export type { Cache, OptimisticContext, OptimisticOptions } from './optimistic.js';
export { optimisticMutationOptions, useOptimisticMutation } from './optimistic.js';
