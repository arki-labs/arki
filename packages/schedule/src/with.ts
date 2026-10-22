import type { FailureOf, SuccessOf } from '@arki/failure';
import { isFailure } from '@arki/failure';

import type { ScheduleRun } from './index.js';

/**
 * A step of a schedule's `with: [...]` list: a plain function that returns the
 * object to add to the context, or a `Failure` to refuse the run. Sync or async.
 */
export type ScheduleStep<In> = (ctx: In) => object | PromiseLike<object>;

/**
 * An around of a schedule's `with: [...]` list: runs `next` inside whatever it
 * sets up (a transaction, a retry, a span) and returns what `next` returns.
 * It wraps every element listed after it and the handler. It adds nothing.
 *
 * The runtime tells an around from a step by `fn.length >= 2`, so an around
 * MUST declare `next` as a plain second parameter. A default or rest parameter
 * (`next = ...`, `...rest`) does not count in `fn.length`: the function would be
 * run as a step. Do not write one.
 */
export type ScheduleAround<In> = <T>(ctx: In, next: () => Promise<T>) => Promise<T>;

/** One element of `with: [...]`, checked against the context built so far. */
export type ScheduleStage<In> = ScheduleStep<In> | ScheduleAround<In>;

/** A context plus what a step added. A missing (`undefined`) base context is replaced, not intersected. */
type Merge<Base, Added> = [Base] extends [undefined] ? Added : Base & Added;

/** The context after one element: a step adds its success keys, an around adds nothing. */
type AfterStage<Ctx, Stage> = Stage extends (...args: infer Args) => unknown
  ? Args extends readonly [unknown, unknown, ...unknown[]]
    ? Ctx
    : Stage extends (...args: never[]) => unknown
      ? Merge<Ctx, SuccessOf<Stage>>
      : Ctx
  : Ctx;

/** The context the handler receives: `Ctx` plus every step's additions, in order. */
export type ContextAfter<Ctx, Stages extends readonly unknown[]> = Stages extends readonly [infer Head, ...infer Tail]
  ? ContextAfter<AfterStage<Ctx, Head>, Tail>
  : Ctx;

/** What each element must be: element `n` is checked against the context after elements `0..n-1`. */
export type CheckedStages<Ctx, Stages extends readonly unknown[]> = Stages extends readonly [infer Head, ...infer Tail]
  ? [ScheduleStage<Ctx>, ...CheckedStages<AfterStage<Ctx, Head>, Tail>]
  : [];

/** The failures the steps can refuse with. */
export type StageRefusals<Stages extends readonly unknown[]> = Stages extends readonly [infer Head, ...infer Tail]
  ? | (Head extends (...args: infer Args) => unknown
        ? Args extends readonly [unknown, unknown, ...unknown[]]
          ? never
          : Head extends (...args: never[]) => unknown
            ? FailureOf<Head>
            : never
        : never)
    | StageRefusals<Tail>
  : never;

/** Erased shape the runtime folds over; the typed overloads of `defineSchedule` carry the real types. */
export type WideStep = (ctx: object | undefined) => unknown;
export type WideAround = (ctx: object | undefined, next: () => Promise<unknown>) => unknown;
export type WideStage = WideStep | WideAround;

/** The runtime's one split: an around declares `next`, so its `length` is at least 2. */
function isStep(stage: WideStage): stage is WideStep {
  return stage.length < 2;
}

/**
 * Fold `stages` around `handler`, in declaration order (onion). A step's
 * returned object is merged into the context; a returned `Failure` ends the run
 * with that failure as the handler's value, which the runtime records as a
 * refusal. An around listed before the step gets that
 * failure as the resolved value of `next()`, like any result; a thrown error
 * rejects `next()`. An around gets `next`, which runs everything listed after it.
 */
export function foldStages(
  stages: readonly WideStage[],
  handler: (ctx: object | undefined, run: ScheduleRun) => Promise<unknown>,
): (ctx: object | undefined, run: ScheduleRun) => Promise<unknown> {
  return (ctx, run) => {
    const from = async (index: number, current: object | undefined): Promise<unknown> => {
      const stage = stages[index];
      if (stage === undefined) return handler(current, run);
      // An around returns what `next` returned; it never inspects it.
      if (!isStep(stage)) return stage(current, async () => from(index + 1, current));
      const added: unknown = await stage(current);
      if (isFailure(added)) return added;
      return from(index + 1, Object.assign({}, current, added));
    };
    return from(0, ctx);
  };
}
