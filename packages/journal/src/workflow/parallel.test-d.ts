import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type { DbHandle } from '../types.js';
import { j } from '../test-support.js';
import { workflow } from './define.js';

// Compile-time only: tsc checks this file, vitest does not run it.
const base = () => workflow('typed', { version: 1, input: z.object({ id: z.string() }) });
const payload = z.object({ v: z.int() });
declare const db: DbHandle;

describe('parallel result types', () => {
  it("wait: 'all' gives an object by branch name, each with its branch's output", () => {
    base()
      .step('prep', () => ({ n: 1 }))
      .parallel(
        'p',
        {
          text: b => b.step('t', ({ input, results }) => `${input.id}${results.prep.n}`).finish(),
          num: b => b.waitFor('w', { signal: 's', schema: payload }).finish(({ results }) => results.w.v),
        },
        { wait: 'all' },
      )
      .step('after', ({ results }) => {
        expectTypeOf(results.p).toEqualTypeOf<{ readonly text: string; readonly num: number }>();
        return 1;
      })
      .finish();
  });

  it("wait: 'any' gives the winner by branch name, and the discriminant narrows result", () => {
    base()
      .parallel(
        'p',
        {
          text: b => b.step('t', () => 'x').finish(),
          num: b => b.step('n', () => 1).finish(),
        },
        { wait: 'any' },
      )
      .step('after', ({ results }) => {
        expectTypeOf(results.p).toEqualTypeOf<
          { readonly branch: 'text'; readonly result: string } | { readonly branch: 'num'; readonly result: number }
        >();
        if (results.p.branch === 'num') expectTypeOf(results.p.result).toEqualTypeOf<number>();
        return 1;
      })
      .finish();
  });

  it('signals of the branches join the signals of the definition', () => {
    const def = base()
      .parallel('p', { a: b => b.waitFor('w', { signal: 's', schema: payload }).finish() }, { wait: 'all' })
      .finish();
    expectTypeOf(def.types?.signals).toEqualTypeOf<{ readonly s: typeof payload } | undefined>();
  });

  it('two waits for one signal with the same schema type are one signal', () => {
    base()
      .parallel(
        'p',
        {
          a: b => b.waitFor('w', { signal: 's', schema: payload }).finish(),
          b: b => b.waitFor('w', { signal: 's', schema: payload }).finish(),
        },
        { wait: 'all' },
      )
      .finish();
  });
});

describe('parallel is refused by the types when it is wrong', () => {
  it('a signal two branches wait for with payloads of different types', () => {
    base()
      .parallel(
        'p',
        {
          a: b => b.waitFor('w', { signal: 's', schema: z.object({ v: z.int() }) }).finish(),
          b: b => b.waitFor('w', { signal: 's', schema: z.object({ text: z.string() }) }).finish(),
        },
        // @ts-expect-error the signal 's' has two payload types: the error message names it
        { wait: 'all' },
      );
  });

  it('a branch that reads a name from a later node, or from another branch', () => {
    base().parallel(
      'p',
      {
        // @ts-expect-error 'later' is not a result at this node
        a: b => b.step('t', ({ results }) => results.later).finish(),
        // @ts-expect-error the other branch's names are not visible
        c: b => b.step('u', ({ results }) => results.t).finish(),
      },
      { wait: 'all' },
    );
  });

  it('a branch node named like an earlier node', () => {
    base()
      .step('prep', () => 1)
      // @ts-expect-error 'prep' is taken
      .parallel('p', { a: b => b.step('prep', () => 1).finish() }, { wait: 'all' });
  });

  it('a duplicate branch name', () => {
    base().parallel(
      'p',
      {
        a: b => b.step('t', () => 1).finish(),
        // @ts-expect-error an object has each key once
        a: b => b.step('t', () => 2).finish(),
      },
      { wait: 'all' },
    );
  });

  it('a wait other than all or any, and a result name that is already taken', () => {
    // @ts-expect-error wait is 'all' or 'any'
    base().parallel('p', { a: b => b.step('t', () => 1).finish() }, { wait: 'some' });
    base()
      .step('p', () => 1)
      // @ts-expect-error 'p' is taken
      .parallel('p', { a: b => b.step('t', () => 1).finish() }, { wait: 'all' });
  });

  it('reading a branch result as the wrong type', () => {
    base()
      .parallel('p', { a: b => b.step('t', () => 'x').finish() }, { wait: 'all' })
      .step('after', ({ results }) => {
        // @ts-expect-error a is a string
        const wrong: number = results.p.a;
        return wrong;
      })
      .finish();
  });
});

describe('def.read of a parallel node', () => {
  const num = z.object({ n: z.number() });
  const text = z.object({ t: z.string() });
  const all = j
    .workflow('read-all', { version: 1, input: z.object({}) })
    .parallel(
      'p',
      {
        a: b => b.output(num).step('x', () => ({ n: 1 })).finish(({ results }) => results.x),
        c: b => b.output(text).step('y', () => ({ t: 'x' })).finish(({ results }) => results.y),
      },
      { wait: 'all' },
    )
    .finish();
  const any = j
    .workflow('read-any', { version: 1, input: z.object({}) })
    .parallel(
      'p',
      {
        a: b => b.output(num).step('x', () => ({ n: 1 })).finish(({ results }) => results.x),
        c: b => b.output(text).step('y', () => ({ t: 'x' })).finish(({ results }) => results.y),
      },
      { wait: 'any' },
    )
    .finish();
  const partly = j
    .workflow('read-partly', { version: 1, input: z.object({}) })
    .parallel(
      'p',
      {
        a: b => b.output(num).step('x', () => ({ n: 1 })).finish(({ results }) => results.x),
        c: b => b.step('y', () => ({ t: 'x' })).finish(),
      },
      { wait: 'all' },
    )
    .finish();
  it("wait: 'all' reads as an object by branch name, typed by the branch schemas", async () => {
    const read = await all.read(db, 'r');
    if (read === undefined || 'code' in read) return;
    expectTypeOf(read.run.results.p).toEqualTypeOf<{ readonly a: { n: number }; readonly c: { t: string } } | undefined>();
  });

  it("wait: 'any' reads as a union, and branch narrows result", async () => {
    const read = await any.read(db, 'r');
    if (read === undefined || 'code' in read) return;
    const found = read.run.results.p;
    expectTypeOf(found).toEqualTypeOf<
      { readonly branch: 'a'; readonly result: { n: number } } | { readonly branch: 'c'; readonly result: { t: string } } | undefined
    >();
    if (found?.branch === 'a') expectTypeOf(found.result).toEqualTypeOf<{ n: number }>();
  });

  it('stays unknown when a branch has no output schema', async () => {
    const read = await partly.read(db, 'r');
    if (read === undefined || 'code' in read) return;
    expectTypeOf(read.run.results.p).toBeUnknown();
  });

  it('a branch with an output schema must finish with that output', () => {
    j.workflow('read-bad', { version: 1, input: z.object({}) }).parallel(
      'p',
      {
        // @ts-expect-error the branch declares { n: number } and finishes with a string
        a: b => b.output(num).step('x', () => 'no').finish(({ results }) => results.x),
      },
      { wait: 'all' },
    );
  });

  it('the output method is for the start of a branch only', () => {
    j.workflow('read-late', { version: 1, input: z.object({}) }).parallel(
      'p',
      {
        // @ts-expect-error a step builder has no output method
        a: b => b.step('x', () => 1).output(num).finish(),
      },
      // @ts-expect-error the bad branch has no type, so its signals are not known either
      { wait: 'all' },
    );
  });
});
