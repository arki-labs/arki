/**
 * Brand applied to oRPC procedures whose .meta.offlineSafe is true.
 * Consumed by @arki/offline/mutations to enforce strict idempotency
 * at the call site: only branded procedures can be queued offline.
 */
export interface OfflineSafeMeta {
  readonly offlineSafe: true;
}

/**
 * Type predicate: any oRPC-ish procedure whose `.meta` includes `offlineSafe: true`.
 *
 * We keep this structurally typed (no nominal brand) so it composes with
 * arbitrary oRPC procedure types from any app's contract.
 */
export type OfflineSafeProcedure<TProc = unknown> = TProc & {
  readonly meta: OfflineSafeMeta;
};

/**
 * Convenience: extract the input type of an offline-safe procedure.
 * Apps wire this via the queue API. Kept loose at the type level
 * because oRPC's procedure types vary across versions; consumers
 * supplying their own typed procedure get full input inference.
 */
export type InferOfflineSafeInput<TProc> =
  TProc extends { input: infer I } ? I : never;
