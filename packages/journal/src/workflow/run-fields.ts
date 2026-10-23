/**
 * What a run is started with besides its input: the key of the tenant it belongs to (`scope`), labels to find it by
 * (`tags`) and free data about it (`metadata`). The limits are written once here; the start schema checks them.
 * The changes a step or an operator makes to them later are here too, with the pure function that applies one.
 * Public signatures name these types, so this file imports no Zod (A-43); the schemas are in `run-field-schemas.ts`.
 */
import type { CommandConflict, CommandFailure, CommandInvalid, CommandNotFound } from '../errors.js';
import type { RetentionAge } from '../retention.js';

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
 * When a run starts, besides its fields: `delay` makes the first node due later (an age from now, or a time; a time in
 * the past is now), and `ttl` ends the run `expired` when its first node has not started that long after it was due.
 * A child run takes neither: it starts when its parent gets to it.
 */
export type RunTiming = {
  readonly delay?: RetentionAge | Date | undefined;
  readonly ttl?: RetentionAge | undefined;
};
/**
 * The bounds of a run's overrides: `maxAttempts` at most 100 tries of a step, and `timeout` at most what a timer can
 * wait (`setTimeout` fires at once past 2^31 - 1 ms).
 */
export const RUN_OVERRIDE_LIMITS = { maxAttempts: 100, timeoutMs: 2_147_483_647 } as const;

/**
 * How a run's steps run, set at its start and kept for its whole life. `maxAttempts` caps the tries of each step,
 * `timeout` caps each step attempt (an age), and `priority` orders the run's step and timer jobs among due jobs:
 * higher first, the scale of an effect's `priority`. A step's retry and timeout are code, so a run can only narrow
 * them. A child run takes none: it runs as its definition says.
 */
export type RunOverrides = {
  readonly maxAttempts?: number | undefined;
  readonly timeout?: RetentionAge | undefined;
  readonly priority?: number | undefined;
};
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
