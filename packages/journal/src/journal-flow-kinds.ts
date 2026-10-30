/**
 * The words of `dot explain --as journal-flow`'s graph, one `as const` list each: the types in
 * `projection.ts` and the schema in `journal-flow-schema.ts` both read them. No Zod here, so the
 * public `./projection` entry stays free of Zod types.
 */

/** The edge kinds of the graph: `from` is the subject, `to` the object. */
export const JOURNAL_FLOW_EDGE_KINDS = ['folds', 'projects', 'reacts', 'owned-by'] as const;
/** When a consumer of an event runs: inside the write's transaction, or after it commits. */
export const JOURNAL_FLOW_TIMINGS = ['same-transaction', 'after-commit'] as const;
/** How often an after-commit consumer sees an event. */
export const JOURNAL_FLOW_DELIVERIES = ['exactly-once', 'at-least-once', 'at-most-once'] as const;
