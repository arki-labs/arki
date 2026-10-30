/**
 * What the worker gives only the journal's own effects (the ones the workflow runner builds): the attempt's fenced
 * command runner, `accept`, and for `ctx.metadata` and `ctx.tags` the same runner without the refusal watch. Internal:
 * neither key is exported from any entry point.
 *
 * Why a marked effect, and not fields of `EffectContext`: an app effect only reaches out, so it never runs a command
 * (D-11). Those commands belong to the engine: a checkpoint, a timer, a start. The marker on the effect definition
 * lets the worker hand them only to the effects the runner built, and the symbol keeps the unwatched runner out of the
 * public type. Both survive the object spreads that bind services and schedules, so no cast is needed anywhere.
 */
import type { AcceptFailure, EffectContext, RootDb } from './types.js';

/** Marks an effect definition the workflow runner built, so the worker gives it `OwnedEffectContext`. */
export const journalOwnedEffect: unique symbol = Symbol('journal.ownedEffect');
/** The key of the unwatched runner on the context of a `journalOwnedEffect`. */
export const unwatchedRun: unique symbol = Symbol('journal.unwatchedRun');

/** What only a `journalOwnedEffect` gets on top of `EffectContext`. */
export type OwnedEffectFields<Run> = {
  readonly run: Run;
  readonly accept: AcceptFailure;
  readonly [unwatchedRun]: Run;
};
/** The context of a `journalOwnedEffect`. */
export type OwnedEffectContext<AppDb = RootDb, Run = unknown> = EffectContext<AppDb> & OwnedEffectFields<Run>;
/** An effect context as the worker builds it: an owned effect's has the owned fields, any other effect's has not. */
export type InternalEffectContext<AppDb = RootDb, Run = unknown> = EffectContext<AppDb> &
  Partial<OwnedEffectFields<Run>>;
