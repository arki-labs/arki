import { ContractProcedure } from '@orpc/contract';
import type { AnySchema, ErrorMap, Meta } from '@orpc/contract';

/** Meta of a contract procedure that is safe to queue offline and replay. */
export type OfflineSafeMeta = {
  readonly offlineSafe: true;
};

/**
 * Mark a contract procedure safe to queue offline. This is the only way to
 * get `offlineSafe: true` into the meta TYPE: `.meta({ offlineSafe: true })`
 * keeps the meta type the builder declared, so the compiler could never see it.
 *
 * Policy is written once, here on the contract:
 * - the server's `idempotency(repo)` middleware dedupes replays of this procedure;
 * - `useOfflineMutation` and `queue.enqueue` compile only for marked procedures.
 *
 * The mark is a declaration: the handler must still be safe to run again
 * when a replay misses the idempotency cache.
 *
 * @example
 * ```ts
 * export const posts = { create: offlineSafe(oc.input(createPost).output(post)) };
 * ```
 */
export function offlineSafe<I extends AnySchema, O extends AnySchema, E extends ErrorMap, M extends Meta>(
  procedure: ContractProcedure<I, O, E, M>,
): ContractProcedure<I, O, E, M & OfflineSafeMeta> {
  const def = procedure['~orpc'];
  return new ContractProcedure({ ...def, meta: { ...def.meta, offlineSafe: true } });
}
