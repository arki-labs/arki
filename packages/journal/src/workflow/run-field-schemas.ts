/**
 * The schemas that check the run fields, timing, overrides and run changes, plus the stored result of an event wait.
 * The run field types are the source, in the Zod-free `run-fields.ts` that public signatures name (A-43);
 * `schemas.test-d.ts` locks each schema to its type both ways. Only the runner, the run machine and the private body
 * of `define.ts` use these, so no public `.d.ts` reaches this file.
 */
import { z } from 'zod';

import { AGE_UNITS, parseAge } from '../retention.js';
import { storedEventRowSchema } from '../zod.js';
import { RUN_FIELD_LIMITS, RUN_OVERRIDE_LIMITS } from './run-fields.js';

/**
 * Checks the shape of the run fields. The size of `metadata` is checked when the run starts, with its JSON form,
 * like the input.
 */
export const runFieldsSchema = z
  .object({
    scope: z.string().min(1).max(RUN_FIELD_LIMITS.scope).optional(),
    tags: z.array(z.string().min(1).max(RUN_FIELD_LIMITS.tag)).max(RUN_FIELD_LIMITS.tags).readonly().optional(),
    metadata: z.record(z.string(), z.unknown()).readonly().optional(),
  })
  .readonly();

/**
 * An age as `RetentionAge` takes it, checked: seconds, or an amount with a unit (`'5m'`, `'2h'`). `positive` refuses 0.
 * The amount of a string is its leading number, so `Number.parseFloat` reads it.
 */
const ageSchema = (positive: boolean) =>
  z.union([
    positive ? z.number().positive() : z.number().nonnegative(),
    z
      .templateLiteral([z.number(), z.enum(AGE_UNITS)])
      .refine(age => (positive ? Number.parseFloat(age) > 0 : Number.parseFloat(age) >= 0), {
        message: positive ? 'an age must be longer than 0' : 'an age must be 0 or more',
      }),
  ]);
/** A wait before a run starts: an age, 0 or more. */
export const delayAgeSchema = ageSchema(false);
/** How long a run may wait to start: an age longer than 0. */
export const ttlAgeSchema = ageSchema(true);

/** Checks `RunTiming`. The type is the source; `schemas.test-d.ts` locks this schema to it both ways. */
export const runTimingSchema = z
  .object({ delay: z.union([delayAgeSchema, z.date()]).optional(), ttl: ttlAgeSchema.optional() })
  .readonly();

/** Checks `RunOverrides`. The type is the source; `schemas.test-d.ts` locks this schema to it both ways. */
export const runOverridesSchema = z
  .object({
    maxAttempts: z.int().min(1).max(RUN_OVERRIDE_LIMITS.maxAttempts).optional(),
    timeout: ttlAgeSchema
      .refine(age => parseAge(age) <= RUN_OVERRIDE_LIMITS.timeoutMs, {
        message: `a timeout must be at most ${RUN_OVERRIDE_LIMITS.timeoutMs} ms`,
      })
      .optional(),
    // The jobs table's priority column is 32 bits.
    priority: z.int32().optional(),
  })
  .readonly();

const metadataKey = z.string().min(1);
/** Checks a `MetadataChange`. The type is the source; `schemas.test-d.ts` locks this schema to it both ways. */
export const metadataChangeSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('set'), patch: z.record(z.string(), z.unknown()).readonly() }),
    z.object({ kind: z.literal('increment'), key: metadataKey, by: z.number() }),
    z.object({ kind: z.literal('append'), key: metadataKey, value: z.unknown() }),
    z.object({ kind: z.literal('remove'), key: metadataKey }),
  ])
  .readonly();

/** Checks the tags `ctx.tags.add` and `journal.workflows.addTags` take: at least one, each as at start. */
export const addedTagsSchema = z.array(z.string().min(1).max(RUN_FIELD_LIMITS.tag)).min(1).readonly();

/**
 * What an event wait stores as its result: the label that took the event and the `seq` of the event's log row. The run
 * keeps no copy of the event, so erasing the event in the log (`forget`) erases it for every run that took it.
 */
export const waitPointerSchema = z.object({ via: z.string().min(1), seq: z.int().positive() });

/** The result an event wait gives a body: the label and the log row, in its JSON form. It is read from the log, never stored. */
export const storedWaitResultSchema = z.object({ via: z.string().min(1), event: storedEventRowSchema });
