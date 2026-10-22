/**
 * `step` and `around` for jobs: plain functions adapted into the job middleware shape.
 *
 *   q.job.use(step(actorFromData)).use(around(inTransaction)).name('refund').input(schema).handler(...)
 *
 * The same function attaches to the other transports with their own `step` and `around`.
 */

import type { Failure, FailureOf, SuccessOf } from '@arki/failure';
import { isFailure } from '@arki/failure';

import type { JobLike } from './types/job.ts';
import type { MiddlewareResult } from './types/middleware.ts';
import type { QueueMeta } from './types/queue.ts';

/** `In` fits `Ctx` when a job whose context is `Ctx` has every key the step or around reads. */
export type FitsContext<Ctx, In> = [Ctx] extends [In] ? unknown : never;

/**
 * The job middleware {@link step} makes: reads `In`, adds `Added`, or refuses with `Refused`.
 * `.use()` checks it against the job's context (`FitsContext`) and adds `Added` to what the handler sees.
 * `_fn` is a method so the job can store it with the other middleware (method parameters are bivariant).
 */
export type StepJobMiddleware<In, Added extends object, Refused extends Failure> = {
  _type: 'middleware';
  /** Tells `.use()` this is a step, so a step that does not fit the job is an error, not a plain middleware. */
  readonly _adapter: 'step';
  /** Carries `Added` to the type of the job's context; never set. */
  readonly _added?: Added;
  _fn(opts: {
    ctx: In;
    data: unknown;
    job: JobLike;
    meta: QueueMeta;
    next: (opts?: { ctx?: unknown }) => Promise<MiddlewareResult<unknown>>;
  }): Promise<MiddlewareResult<unknown> | Refused>;
};

/** The job middleware {@link around} makes: wraps the rest of the chain and the handler, adds nothing. */
export type AroundJobMiddleware<In> = {
  _type: 'middleware';
  /** Tells `.use()` this is an around, so an around that does not fit the job is an error. */
  readonly _adapter: 'around';
  _fn(opts: {
    ctx: In;
    data: unknown;
    job: JobLike;
    meta: QueueMeta;
    next: (opts?: { ctx?: unknown }) => Promise<MiddlewareResult<unknown>>;
  }): Promise<MiddlewareResult<unknown>>;
};

/**
 * Run a step before a job's handler: `q.job.use(step(authed))`.
 *
 * A step is a plain function. Its parameter is the least context it reads; it
 * returns an object to add to the context, or a failure to refuse the job:
 *
 *   const authed = (ctx: { principal: Principal | null }) =>
 *     ctx.principal === null ? SignInRequired() : { principal: ctx.principal };
 *
 * A refusal is the job's outcome, as if the handler had returned that failure:
 * the handler does not run, and the job fails without a retry unless its
 * `retry` backoff judges that failure retryable.
 */
export function step<In extends object, R extends object | PromiseLike<object>>(
  fn: (ctx: In) => R,
): StepJobMiddleware<In, Extract<SuccessOf<(ctx: In) => R>, object>, FailureOf<(ctx: In) => R>>;
// Erasure seam: `SuccessOf` of a generic `R` does not narrow under `isFailure`, so
// the body is written against `object` and the overload above carries the types.
export function step(fn: (ctx: object) => object | PromiseLike<object>): unknown {
  return {
    _type: 'middleware',
    _adapter: 'step',
    _fn: async (opts: {
      ctx: object;
      next: (opts?: { ctx?: object }) => Promise<MiddlewareResult<object>>;
    }): Promise<MiddlewareResult<object> | Failure> => {
      const value = await fn(opts.ctx);
      if (isFailure<unknown>(value)) return value;
      return opts.next({ ctx: { ...opts.ctx, ...value } });
    },
  };
}

/**
 * Wrap a job: `q.job.use(around(inTransaction))`.
 *
 * An around is a plain function that runs `next` inside whatever it sets up
 * (a transaction, a span, a lock) and returns what `next` returns. It wraps
 * everything declared after it: later steps and the handler.
 *
 * A refusal (a later step's) or a failure the handler returns is the value `next`
 * resolves to: no throw, so nothing rolls back by itself. An around that cares
 * checks the result with `isFailure`. A handler that throws still rejects
 * `next`. Either way the failure stays the job's outcome.
 */
export function around<In extends object>(
  fn: <T>(ctx: In, next: () => Promise<T>) => Promise<T>,
): AroundJobMiddleware<In> {
  return {
    _type: 'middleware',
    _adapter: 'around',
    _fn: async opts => {
      const result = await fn(opts.ctx, async () => {
        const inner = await opts.next();
        return isFailure<unknown>(inner.output) ? inner.output : inner;
      });
      return isFailure<unknown>(result) ? { ctx: opts.ctx, output: result } : result;
    },
  };
}
