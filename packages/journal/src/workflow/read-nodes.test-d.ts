import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type { RootDb } from '../types.js';
import { j } from '../test-support.js';

// Compile-time only: tsc checks this file, vitest does not run it.
const kid = j
  .workflow('rn-kid', { version: 1, input: z.object({ n: z.number() }), output: z.object({ doubled: z.number() }) })
  .step('s', () => 1)
  .finish(() => ({ doubled: 2 }));
const bareKid = j
  .workflow('rn-bare', { version: 1, input: z.object({}) })
  .step('s', () => 1)
  .finish();
const parent = j
  .workflow('rn-parent', { version: 1, input: z.object({}) })
  .sleep('nap', '1h')
  .child('one', kid, { input: () => ({ n: 1 }) })
  .child('picked', () => kid, { input: () => ({ n: 1 }) })
  .child('bare', bareKid, { input: () => ({}) })
  .map('all', kid, { items: () => [1], input: (_ctx, n) => ({ n }) })
  .map('any', kid, { items: () => [1], input: (_ctx, n) => ({ n }), wait: 'any' })
  .map('bareAll', bareKid, { items: () => [1], input: () => ({}) })
  .finish();
declare const db: RootDb;

describe('def.read of a sleep, a child and a map, as types', () => {
  it('types what a schema checked, and leaves the rest unknown', async () => {
    const read = await parent.read(db, 'r');
    if (read === undefined || 'code' in read) return;
    const { results } = read.run;
    expectTypeOf(results.nap).toEqualTypeOf<null | undefined>();
    expectTypeOf(results.one).toEqualTypeOf<{ doubled: number } | undefined>();
    expectTypeOf(results.all).toEqualTypeOf<{ doubled: number }[] | undefined>();
    expectTypeOf(results.any).toEqualTypeOf<{ doubled: number } | undefined>();
  });

  it('a child chosen at run time, a child with no output schema and a map of one are unknown: nothing checks them', async () => {
    const read = await parent.read(db, 'r');
    if (read === undefined || 'code' in read) return;
    expectTypeOf(read.run.results.picked).toBeUnknown();
    expectTypeOf(read.run.results.bare).toBeUnknown();
    expectTypeOf(read.run.results.bareAll).toBeUnknown();
    // @ts-expect-error -- a node the workflow does not have.
    void read.run.results.missing;
  });
});
