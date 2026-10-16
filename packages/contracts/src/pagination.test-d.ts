import { describe, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';

import { keyset, pageInput } from './pagination.js';

const storyOrder = keyset({ createdAt: 'desc', id: 'desc' });

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
