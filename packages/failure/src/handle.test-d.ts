import { describe, expectTypeOf, it } from 'vitest';

import { invariant, unreachable } from './handle.js';

describe('types of invariant and unreachable', () => {
  it('invariant narrows the variable after the call, so callers drop null checks', () => {
    const read = (value: string | undefined) => {
      invariant(value !== undefined);
      expectTypeOf(value).toEqualTypeOf<string>();
    };
    expectTypeOf(read).returns.toEqualTypeOf<void>();
  });

  it('unreachable accepts only never, so a new union member fails to compile', () => {
    const exhaust = (kind: 'a' | 'b') => {
      switch (kind) {
        case 'a': {
          return 1;
        }
        case 'b': {
          return 2;
        }
        default: {
          return unreachable(kind);
        }
      }
    };
    expectTypeOf(exhaust).returns.toEqualTypeOf<1 | 2>();
    // @ts-expect-error -- a string is not never
    unreachable('x');
  });
});
