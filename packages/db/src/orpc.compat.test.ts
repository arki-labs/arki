/**
 * The oRPC behaviour `@arki/db/orpc` stands on, pinned against the installed
 * `@orpc/server` (1.x). None of this calls our middleware.
 *
 * Why these tests exist: the transaction middleware reruns the handler by
 * calling `next()` again, reads `procedure['~orpc']` to check it is last and
 * that output is validated inside, and relies on input being validated before
 * it. These are oRPC internals. If an upgrade changes one, this file fails
 * first, with a name that says which seam moved.
 */
import { oc } from '@orpc/contract';
import { call, implement, os } from '@orpc/server';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { transactionalProcedureConfig } from './orpc.js';

let parses = 0;
const contract = {
  echo: oc
    .input(
      z.object({ n: z.number() }).transform(value => {
        parses += 1;
        return value;
      }),
    )
    .output(z.object({ n: z.number().max(10) })),
};

describe('oRPC seams the transaction middleware relies on', () => {
  it('next() can be called again: it reruns the handler, with a fresh context each time, and input parsed once', async () => {
    parses = 0;
    const seen: unknown[] = [];
    const twice = os.$context<{ attempt?: number }>().middleware(async ({ next }) => {
      await next({ context: { attempt: 1 } });
      return next({ context: { attempt: 2 } });
    });
    const procedure = implement(contract, transactionalProcedureConfig)
      .echo.use(twice)
      .handler(({ context, input }) => {
        seen.push(context.attempt);
        return input;
      });
    expect(await call(procedure, { n: 1 })).toEqual({ n: 1 });
    expect(seen).toEqual([1, 2]);
    expect(parses).toBe(1);
  });

  it('with transactionalProcedureConfig, output is validated inside the last middleware (next() rejects)', async () => {
    let nextRejected = false;
    const watch = os.middleware(async ({ next }) => {
      try {
        return await next();
      } catch (error) {
        nextRejected = true;
        throw error;
      }
    });
    const procedure = implement(contract, transactionalProcedureConfig)
      .echo.use(watch)
      .handler(() => ({ n: 99 }));
    await expect(call(procedure, { n: 1 })).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    expect(nextRejected).toBe(true);
  });

  it('without it, output is validated after every middleware returned: after a commit', async () => {
    let nextRejected = false;
    const watch = os.middleware(async ({ next }) => {
      try {
        return await next();
      } catch (error) {
        nextRejected = true;
        throw error;
      }
    });
    const procedure = implement(contract)
      .echo.use(watch)
      .handler(() => ({ n: 99 }));
    await expect(call(procedure, { n: 1 })).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    expect(nextRejected).toBe(false);
  });

  it('use() stores the middleware itself, last, also after a router-level use() and router enhancement', () => {
    const first = os.middleware(({ next }) => next());
    const last = os.middleware(({ next }) => next());
    const impl = implement(contract, transactionalProcedureConfig).use(first);
    const procedure = impl.echo.use(last).handler(({ input }) => input);
    expect(procedure['~orpc'].middlewares.at(-1)).toBe(last);
    expect(procedure['~orpc'].outputValidationIndex).toBeGreaterThanOrEqual(procedure['~orpc'].middlewares.length);

    const router = impl.router({ echo: procedure });
    expect(router.echo['~orpc'].middlewares.at(-1)).toBe(last);
    expect(router.echo['~orpc'].outputValidationIndex).toBeGreaterThanOrEqual(router.echo['~orpc'].middlewares.length);
  });
});
