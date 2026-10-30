/**
 * The schemas that read `dot explain --as event-map`'s graph back from untyped JSON (the manifest's
 * meta, and the `--json` document).
 * Internal: the types in `projection.ts` are the source, and `projection.test-d.ts` locks these
 * schemas to them with an exact two-way type test.
 */
import { z } from 'zod';

import { EVENT_MAP_DELIVERIES, EVENT_MAP_EDGE_KINDS, EVENT_MAP_TIMINGS } from './event-map-kinds.js';

const named = { id: z.string(), name: z.string() };
const deps = z.array(z.string());
const graphShape = {
  nodes: z.array(
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
        .object({
          ...named,
          kind: z.literal('workflow'),
          version: z.number().int(),
          deps,
          signals: deps,
          opaqueSteps: deps,
        })
        .readonly(),
      z.object({ ...named, kind: z.literal('feature') }).readonly(),
      z.object({ ...named, kind: z.literal('command') }).readonly(),
      z.object({ ...named, kind: z.literal('entrypoint'), feature: z.string(), file: z.string() }).readonly(),
    ]),
  ),
  edges: z.array(
    z
      .object({
        kind: z.enum(EVENT_MAP_EDGE_KINDS),
        from: z.string(),
        to: z.string(),
        timing: z.enum(EVENT_MAP_TIMINGS).optional(),
        delivery: z.enum(EVENT_MAP_DELIVERIES).optional(),
        node: z.string().optional(),
        label: z.string().optional(),
        undo: z.literal(true).optional(),
      })
      .readonly(),
  ),
};

/** The graph, as `EventMapGraph` types it. */
export const eventMapGraphSchema = z.object(graphShape).readonly();

/** What `journal({ j })` puts in the manifest: the graph and where the entrypoint scan looks. */
export const eventMapMetaSchema = z.object({ ...graphShape, entrypointRoot: z.string() }).readonly();

/** The document `dot explain --as event-map --json` prints: the graph, plus the files the scan could not read. */
export const eventMapDocumentSchema = z
  .object({
    ...graphShape,
    format: z.literal('event-map'),
    problems: z.array(z.object({ file: z.string(), reason: z.string() }).readonly()),
  })
  .readonly();

/**
 * An event definition is a function with a `type` (`OrderPlaced({ ... })` builds the event), which an object schema
 * refuses, so this one checks both parts.
 */
const eventDefinitionSchema = z.custom<{ readonly type: string }>(
  value => typeof value === 'function' && typeof Reflect.get(value, 'type') === 'string',
);

/**
 * What the entrypoint scan keeps from a module's export: a `j.command`, a plain object with a `name`, the
 * event definitions it `writes` and a `handler`. Nothing else a procedure imports has all four.
 */
export const journalCommandSchema = z.looseObject({
  name: z.string().min(1),
  writes: z.array(eventDefinitionSchema),
  handler: z.custom<(...args: never[]) => unknown>(value => typeof value === 'function'),
});
