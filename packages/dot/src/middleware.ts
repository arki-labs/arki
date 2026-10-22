/**
 * `@arki/dot/middleware` — `derive`: a context step written once and attached to any transport.
 *
 * Design: RFC `docs/rfcs/2026-10-21-dot-middleware.md`.
 *
 *   // app: core/middleware.ts
 *   export const authed = derive('principal', (ctx: { principal: Principal | null }) => requirePrincipal(ctx.principal));
 *   export const admin = derive((ctx: { principal: Principal }) => (isAdmin(ctx.principal) ? {} : AccessDenied()));
 *
 *   // a procedure
 *   impl.refund.use(fromDerive(authed)).use(fromDerive(admin)).handler(({ context }) => …);
 *
 * A step reads the least context it needs (its parameter type), adds to it
 * (its return value) or refuses the call by returning a typed failure. Nothing
 * is restated: what it adds and how it refuses are inferred from the return.
 * The keyed form puts one value under a name; the object form adds every key
 * of the object it returns. Each transport attaches a step with its own
 * `fromDerive`, which decides what a refusal becomes on that transport.
 */
import type { Failure } from '@arki/failure';
import { isFailure } from '@arki/failure';

/** A context step: reads `In`, adds `Out`, or refuses with the failure `F`. Made by {@link derive}. */
export type Step<In, Out, F extends Failure> = {
  /** Run the step on a call's context: what it adds, or the failure that refuses the call. */
  readonly run: (context: In) => Promise<StepResult<Out, F>>;
};

/**
 * One run of a step. Tagged, not `Out | F`: an adapter narrows on `ok` even
 * where `Out` is still generic, which `Exclude<Out | F, Failure>` cannot do.
 */
export type StepResult<Out, F extends Failure> =
  { readonly ok: true; readonly added: Out } | { readonly ok: false; readonly failure: F };

/** What a step's function returns, minus its failures. */
type Added<R> = Exclude<Awaited<R>, Failure>;

/** The failures a step's function can return. */
type Refused<R> = Extract<Awaited<R>, Failure>;

/**
 * Make a context step. `derive('principal', fn)` adds `fn`'s value under
 * `principal`; `derive(fn)` adds every key of the object `fn` returns. A
 * failure returned instead refuses the call.
 */
export function derive<const Key extends string, In, R>(
  key: Key,
  fn: (context: In) => R,
): Step<In, Readonly<Record<Key, Added<R>>>, Refused<R>>;
export function derive<In, R extends object | PromiseLike<object>>(
  fn: (context: In) => R,
): Step<In, Added<R>, Refused<R>>;
export function derive(
  ...args: readonly [key: string, fn: (context: unknown) => unknown] | readonly [fn: (context: unknown) => unknown]
): unknown {
  const [key, fn] = args.length === 2 ? args : [undefined, args[0]];
  return {
    run: async (context: unknown) => {
      const value: unknown = await fn(context);
      if (isFailure(value)) return { ok: false, failure: value };
      return { ok: true, added: key === undefined ? value : { [key]: value } };
    },
  };
}
