import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type { Failure } from './failure.js';
import { collect, partition } from './collect.js';
import { defineFailure } from './failure.js';

const NotFound = defineFailure('item.not_found', { data: z.object({ id: z.number() }) });
const Banned = defineFailure('user.banned');

const find = (id: number) => (id % 2 === 0 ? { id } : NotFound({ id }));
const userName = (banned: boolean) => (banned ? Banned() : 'name');

describe('partition', () => {
  it('splits successes from failures, each in input order', () => {
    const [items, missing] = partition([0, 1, 2, 3].map(id => find(id)));
    expect(items).toEqual([{ id: 0 }, { id: 2 }]);
    expect(missing.map(failure => failure.data.id)).toEqual([1, 3]);
    expectTypeOf(items).toEqualTypeOf<{ id: number }[]>();
    expectTypeOf(missing).toEqualTypeOf<Failure<'item.not_found', { id: number }>[]>();
  });
});

describe('collect', () => {
  it('returns every success, typed per position, when nothing failed', () => {
    const both = collect([find(0), userName(false)] as const);
    expect(both).toEqual([{ id: 0 }, 'name']);
    expectTypeOf(both).toEqualTypeOf<
      [{ id: number }, 'name'] | Failure<'item.not_found', { id: number }> | Failure<'user.banned', undefined>
    >();
  });

  it('returns the first failure when any value failed', () => {
    expect(collect([find(0), find(1), find(3)])).toMatchObject({ code: 'item.not_found', data: { id: 1 } });
  });
});
