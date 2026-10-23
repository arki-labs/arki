/**
 * What the worker gives only the journal's own workflow step effect: the attempt's fenced command runner without the
 * refusal watch, for `ctx.metadata` and `ctx.tags`. Internal: neither key is exported from any entry point.
 *
 * Why symbol keys on a marked effect, and not a field of `EffectContext`: an app effect must never get a way around
 * the refusal guarantee (a success after a refusal it did not accept fails its job). A symbol no app can import keeps
 * the runner out of reach and out of the public type, and the marker on the effect definition lets the worker hand it
 * only to the step effect the workflow runner built. Both survive the object spreads that bind services and
 * schedules, so no cast is needed anywhere.
 */
import type { EffectContext, RootDb } from './types.js';

/** Marks an effect definition the workflow runner built, so the worker gives it `unwatchedRun`. */
export const journalOwnedEffect: unique symbol = Symbol('journal.ownedEffect');
/** The key of the unwatched runner on the context of a `journalOwnedEffect`. */
export const unwatchedRun: unique symbol = Symbol('journal.unwatchedRun');

/** An effect context as the worker builds it: an owned effect's has the unwatched runner, any other effect's has not. */
export type InternalEffectContext<AppDb = RootDb, Run = unknown> = EffectContext<AppDb, Run> & {
  readonly [unwatchedRun]?: Run;
};
