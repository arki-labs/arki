import type { z } from 'zod';
import { describe, expectTypeOf, it } from 'vitest';

import type { FailureOf } from '@arki/failure';

import type { CURSOR_DECODE_FAILURES, CURSOR_ENCODE_FAILURES, CURSOR_FAILURES } from './pagination.js';
import { keyset, pageInput } from './pagination.js';

const storyOrder = keyset({ createdAt: 'desc', id: 'desc' });

it('keeps the declaration readonly so callers cannot change the codec keys', () => {
  expectTypeOf<typeof storyOrder>().toEqualTypeOf<Readonly<typeof storyOrder>>();
  expectTypeOf<typeof storyOrder.keys>().toEqualTypeOf<Readonly<typeof storyOrder.keys>>();
  const mutate = () => {
    // @ts-expect-error Removing a key would invalidate the inferred decoded fields.
    storyOrder.keys.pop();
    // @ts-expect-error Replacing the declaration's keys would disagree with its codec.
    storyOrder.keys = [];
  };
  expectTypeOf(mutate).toBeFunction();
});

describe('pageInput', () => {
  it('a client sends the cursor as a string (typed clients and keyset hooks read this)', () => {
    expectTypeOf(pageInput(storyOrder)).toExtend<
      z.ZodType<unknown, { cursor?: string | undefined; limit?: number | undefined }>
    >();
    // @ts-expect-error a number is not a cursor
    const wrong: z.input<ReturnType<typeof pageInput<typeof storyOrder.order>>> = { cursor: 1 };
    expectTypeOf(wrong).not.toBeAny();
  });
});

// The canonical tuples and actual public operations must stay equal in both directions.
it('keeps cursor failure closure exact rather than a generic Failure', () => {
  expectTypeOf<FailureOf<typeof storyOrder.decode>>().toEqualTypeOf<
    ReturnType<(typeof CURSOR_DECODE_FAILURES)[number]>
  >();
  expectTypeOf<FailureOf<typeof storyOrder.encode>>().toEqualTypeOf<
    ReturnType<(typeof CURSOR_ENCODE_FAILURES)[number]>
  >();
  expectTypeOf<FailureOf<typeof storyOrder.decode> | FailureOf<typeof storyOrder.encode>>().toEqualTypeOf<
    ReturnType<(typeof CURSOR_FAILURES)[number]>
  >();
});
