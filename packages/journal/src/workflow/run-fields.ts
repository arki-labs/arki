/**
 * What a run is started with besides its input: the key of the tenant it belongs to (`scope`), labels to find it by
 * (`tags`) and free data about it (`metadata`). The limits are written once here; the start schema checks them.
 * The changes a step or an operator makes to them later are here too, with the pure function that applies one.
 */
import { z } from 'zod';

import type { CommandConflict, CommandFailure, CommandInvalid, CommandNotFound } from '../errors.js';
import type { RetentionAge } from '../retention.js';
import { AGE_UNITS } from '../retention.js';

/** The limits on the run fields: `scope` length, number of `tags`, length of one tag, and `metadata` as JSON bytes. */
export const RUN_FIELD_LIMITS = { scope: 256, tags: 10, tag: 128, metadataBytes: 262_144 } as const;
/** The most items one `def.startBatch` takes, and the most run ids `journal.workflows.batch` lists. */
export const BATCH_LIMIT = 1000;

/** The run fields `def.start` takes. A child run takes none: it inherits its parent's `scope`, and no tags or metadata. */
export type RunFields = {
  readonly scope?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
};

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

/**
 * When a run starts, besides its fields: `delay` makes the first node due later (an age from now, or a time; a time in
 * the past is now), and `ttl` ends the run `expired` when its first node has not started that long after it was due.
 * A child run takes neither: it starts when its parent gets to it.
 */
export type RunTiming = {
  readonly delay?: RetentionAge | Date | undefined;
  readonly ttl?: RetentionAge | undefined;
};
/** Checks `RunTiming`. The type is the source; `schemas.test-d.ts` locks this schema to it both ways. */
export const runTimingSchema = z
  .object({ delay: z.union([delayAgeSchema, z.date()]).optional(), ttl: ttlAgeSchema.optional() })
  .readonly();

/** A run's metadata: a JSON object. */
export type RunMetadata = Readonly<Record<string, unknown>>;

/**
 * One change to a run's metadata after its start: what `ctx.metadata` and `journal.workflows.setMetadata` make, one
 * `MetadataChanged` event each. `set` merges `patch` into the top level, `increment` adds `by` to a number (a missing
 * key counts as 0), `append` pushes `value` onto an array (a missing key starts one), `remove` drops a key.
 */
export type MetadataChange =
  | { readonly kind: 'set'; readonly patch: RunMetadata }
  | { readonly kind: 'increment'; readonly key: string; readonly by: number }
  | { readonly kind: 'append'; readonly key: string; readonly value: unknown }
  | { readonly kind: 'remove'; readonly key: string };

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
 * Why `change` cannot apply to `metadata`, or null when it can: `increment` needs a number (or nothing) at its key,
 * and `append` an array (or nothing). The size is checked after, on the changed metadata.
 */
export function metadataRefusal(metadata: RunMetadata, change: MetadataChange): string | null {
  if (change.kind === 'increment') {
    const now = metadata[change.key];
    return now === undefined || typeof now === 'number' ? null : `metadata "${change.key}" is not a number`;
  }
  if (change.kind === 'append') {
    const now = metadata[change.key];
    return now === undefined || Array.isArray(now) ? null : `metadata "${change.key}" is not an array`;
  }
  return null;
}

/**
 * `metadata` after `change`. Pure: the `MetadataChanged` reducer and the command that checks the change both call it,
 * so a replay rebuilds what the command stored. The command refuses a change `metadataRefusal` names, so the fallbacks
 * below (0 for a value that is not a number, an empty array for one that is not an array) never meet a stored event.
 */
export function changedMetadata(metadata: RunMetadata, change: MetadataChange): RunMetadata {
  switch (change.kind) {
    case 'set': {
      return { ...metadata, ...change.patch };
    }
    case 'increment': {
      const now = metadata[change.key];
      return { ...metadata, [change.key]: (typeof now === 'number' ? now : 0) + change.by };
    }
    case 'append': {
      const now = metadata[change.key];
      return { ...metadata, [change.key]: [...(Array.isArray(now) ? now : []), change.value] };
    }
    case 'remove': {
      const { [change.key]: _removed, ...rest } = metadata;
      return rest;
    }
  }
}

/**
 * The tags `added` brings to a run that has `tags`: each one once, in the order given, without those it has. An empty
 * list means nothing changes.
 */
export const newTags = (tags: readonly string[], added: readonly string[]): string[] =>
  [...new Set(added)].filter(tag => !tags.includes(tag));

/**
 * What a metadata change returns: the run's metadata after it, or why it was refused. `CommandNotFound`: no such run.
 * `CommandConflict`: the run has finished. `CommandInvalid`: a wrong value type, or metadata over the limit.
 */
export type MetadataOutcome = { readonly metadata: RunMetadata } | CommandNotFound | CommandConflict | CommandInvalid;
/** What adding tags returns: all the run's tags after it, or the refusal, as for `MetadataOutcome` (over the limit). */
export type TagsOutcome = { readonly tags: readonly string[] } | CommandNotFound | CommandConflict | CommandInvalid;

/**
 * `ctx.metadata` in a step or undo body. Each call is one command and one `MetadataChanged` event on the run, committed
 * at once, so a reader sees it while the step still runs. A refusal is the value the call returns (`CommandConflict`
 * once the run has finished, `CommandInvalid` for a wrong type or metadata over the limit); it never fails the step.
 * A retried attempt runs its calls again: `set` and `remove` give the same metadata, `increment` and `append` apply
 * once more per attempt.
 */
export type MetadataContext = {
  /** Merges `patch` into the top level of the metadata. */
  set(patch: RunMetadata): Promise<MetadataOutcome | CommandFailure>;
  /** Adds `by` (default 1) to the number at `key`. A missing key counts as 0. */
  increment(key: string, by?: number): Promise<MetadataOutcome | CommandFailure>;
  /** Pushes `value` onto the array at `key`. A missing key starts an array. */
  append(key: string, value: unknown): Promise<MetadataOutcome | CommandFailure>;
  /** Drops `key`. A missing key is no change. */
  remove(key: string): Promise<MetadataOutcome | CommandFailure>;
};

/** `ctx.tags` in a step or undo body: one command and one `RunTagged` event per call that adds a tag, like `ctx.metadata`. */
export type TagsContext = {
  /** Adds tags the run does not have yet. More than `RUN_FIELD_LIMITS.tags` in all is `CommandInvalid`. */
  add(...tags: string[]): Promise<TagsOutcome | CommandFailure>;
};
