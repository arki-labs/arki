/**
 * `with: [...]` on a command: plain functions that run before `run`.
 *
 * A step is `(ctx) => object | Failure`, sync or async. The keys of the object it returns are added to
 * the context of everything after it; a Failure is the command's failure and `run` never starts.
 * An around is `(ctx, next) => Promise<T>`. It wraps everything listed after it and `run`, adds nothing,
 * and passes `next()`'s result through.
 *
 * Order is declaration order. A step sees every key added before it.
 */
import type { SuccessOf } from '@arki/failure';
import { isFailure } from '@arki/failure';

/** A step: reads the context, adds the keys of the object it returns, or refuses with a Failure. */
export type StepFn = (ctx: never) => object | PromiseLike<object>;

/** An around: runs `next` inside whatever it sets up and returns what `next` returns. Generic in `T`, so it cannot change the result. */
export type AroundFn = <T>(ctx: never, next: () => Promise<T>) => Promise<T>;

/** What `with` may list. */
export type WithFn = StepFn | AroundFn;

/** What an element adds to the context: a step its returned keys, an around nothing. */
export type AddedBy<F> = F extends (ctx: never) => unknown
  ? [SuccessOf<F>] extends [never]
    ? unknown
    : SuccessOf<F>
  : unknown;

/** The context after every element of `List` has run, starting from `Ctx`. */
export type CtxAfter<Ctx, List extends readonly unknown[]> = List extends readonly [infer Head, ...infer Rest]
  ? CtxAfter<Ctx & AddedBy<Head>, Rest>
  : Ctx;

/** What an element that reads keys its context lacks becomes: a property no function has, so the error names the problem. */
type MissingKeys = { readonly 'with: this element reads keys no earlier element added': never };

/** One element checked against the context built before it. */
type Fits<Ctx, F> = F extends (ctx: infer In, ...rest: never[]) => unknown
  ? [Ctx] extends [In]
    ? unknown
    : MissingKeys
  : unknown;

/**
 * `List` checked position by position: element `i` must accept the base context plus everything
 * elements before `i` added. Intersected with `readonly [...List]`, so a bad element is the one
 * the compiler points at.
 */
export type Checked<Ctx, List extends readonly unknown[]> = List extends readonly [infer Head, ...infer Rest]
  ? readonly [Fits<Ctx, Head>, ...Checked<Ctx & AddedBy<Head>, Rest>]
  : readonly [];

/*
 * What a tree holds. Method syntax on purpose, as `run` in `AnyCommand`: method parameters are
 * compared bivariantly, so `(ctx: { principal: Principal }) => ...` fits a context typed `object`.
 */
export type ErasedWith = { bivarianceHack(ctx: object, next?: () => Promise<unknown>): unknown }['bivarianceHack'];

/*
 * The runtime tells a step from an around by `fn.length`: an around must declare `next`, so it has two
 * or more parameters. A step must declare at most one. A default value (`(ctx, next = x) => ...`) or a
 * rest parameter stops `.length` counting, so an around with either is taken for a step; a step with a
 * second parameter is taken for an around. Write them with plain parameters.
 */
export function isAround(fn: ErasedWith): boolean {
  return fn.length >= 2;
}

/**
 * Run `last` inside `items`, in order. A step's keys are merged into the context for what follows; a
 * refusal is returned as the result without calling anything after it. An around receives a `next`
 * that runs the rest of the list.
 */
export async function runWith<Ctx extends object>(
  items: readonly ErasedWith[],
  ctx: Ctx,
  last: (ctx: Ctx) => unknown,
): Promise<unknown> {
  const [head, ...rest] = items;
  if (head === undefined) return last(ctx);
  if (isAround(head)) return head(ctx, async () => runWith(rest, ctx, last));
  const added: unknown = await head(ctx);
  if (isFailure(added)) return added;
  return runWith(rest, Object.assign({}, ctx, added), last);
}
