/**
 * The schema that reads `dot explain --as journal-flow`'s graph back from untyped manifest JSON.
 * Internal: the types in `projection.ts` are the source, and `projection.test-d.ts` locks this
 * schema to them with an exact two-way type test.
 */
import { z } from 'zod';

import { JOURNAL_FLOW_DELIVERIES, JOURNAL_FLOW_EDGE_KINDS, JOURNAL_FLOW_TIMINGS } from './journal-flow-kinds.js';

const named = { id: z.string(), name: z.string() };
const deps = z.array(z.string());
/** The graph, as `JournalFlowGraph` types it. */
export const journalFlowGraphSchema = z
  .object({
    nodes: z
      .array(
        z.discriminatedUnion('kind', [
          z.object({ ...named, kind: z.literal('event') }).readonly(),
          z.object({ ...named, kind: z.literal('entity'), table: z.string() }).readonly(),
          z.object({ ...named, kind: z.literal('projection'), lane: z.enum(['inline', 'async']) }).readonly(),
          z
            .object({
              ...named,
              kind: z.literal('effect'),
              deps,
              retry: z
                .object({ policy: z.enum(['default', 'custom']), maxRetries: z.number().int().nullable() })
                .readonly(),
            })
            .readonly(),
          z.object({ ...named, kind: z.literal('tap'), deps }).readonly(),
          z
            .object({ ...named, kind: z.literal('workflow'), version: z.number().int(), deps, signals: deps })
            .readonly(),
          z.object({ ...named, kind: z.literal('feature') }).readonly(),
        ]),
      ),
    edges: z
      .array(
        z
          .object({
            kind: z.enum(JOURNAL_FLOW_EDGE_KINDS),
            from: z.string(),
            to: z.string(),
            timing: z.enum(JOURNAL_FLOW_TIMINGS).optional(),
            delivery: z.enum(JOURNAL_FLOW_DELIVERIES).optional(),
          })
          .readonly(),
      ),
  })
  .readonly();

