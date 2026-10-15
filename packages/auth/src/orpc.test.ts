/**
 * Ownership assertions. What they must guarantee: a stranger reading a row
 * gets the same NOT_FOUND as for a missing row (no existence leak); a
 * mutation may say FORBIDDEN only because the procedure chose it; and after
 * the call the row is non-null, typed, with no `!`.
 */
import { ORPCError } from '@orpc/server';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { assertFound, assertOwnedOrForbidden, assertOwnedOrNotFound } from './orpc.js';

type StoryRow = { readonly id: `sty_${string}`; readonly userId: `usr_${string}`; readonly title: string };

const mine: StoryRow = { id: 'sty_1', userId: 'usr_me', title: 'The Lighthouse' };

/** The oRPC error code a call throws, or `null` when it passes. */
function codeOf(run: () => void): string | null {
  try {
    run();
    return null;
  } catch (error) {
    if (error instanceof ORPCError) return error.code;
    throw error;
  }
}

describe('assertOwnedOrNotFound (reads)', () => {
  it('passes the owner and narrows the row', () => {
    const row: StoryRow | null = mine;
    assertOwnedOrNotFound(row, 'usr_me', 'Story');
    expectTypeOf(row).toEqualTypeOf<StoryRow>();
    expect(row.title).toBe('The Lighthouse');
  });

  it("someone else's row and a missing row look the same: NOT_FOUND with the same message", () => {
    const stranger = () => assertOwnedOrNotFound(mine, 'usr_stranger', 'Story');
    const missing = () => assertOwnedOrNotFound(null, 'usr_stranger', 'Story');
    expect(codeOf(stranger)).toBe('NOT_FOUND');
    expect(codeOf(missing)).toBe('NOT_FOUND');
    expect(stranger).toThrow('Story not found');
    expect(missing).toThrow('Story not found');
  });
});

describe('assertOwnedOrForbidden (mutations)', () => {
  it('missing → NOT_FOUND, not yours → FORBIDDEN, yours → passes', () => {
    expect(codeOf(() => assertOwnedOrForbidden(undefined, 'usr_me', 'Story'))).toBe('NOT_FOUND');
    expect(codeOf(() => assertOwnedOrForbidden(mine, 'usr_stranger', 'Story'))).toBe('FORBIDDEN');
    expect(codeOf(() => assertOwnedOrForbidden(mine, 'usr_me', 'Story'))).toBeNull();
  });
});

describe('assertFound (rows a getOwned query already scoped to the caller)', () => {
  it('missing → NOT_FOUND; anything else passes, narrowed', () => {
    const row: StoryRow | undefined = mine;
    expect(codeOf(() => assertFound(null, 'Story'))).toBe('NOT_FOUND');
    assertFound(row, 'Story');
    expectTypeOf(row).toEqualTypeOf<StoryRow>();
  });

  it('only rows with an owner reach the ownership checks', () => {
    // @ts-expect-error a row without `userId` cannot be checked for ownership
    expect(() => assertOwnedOrNotFound({ id: 'x' }, 'usr_me', 'Thing')).toThrow();
  });
});
