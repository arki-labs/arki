/**
 * Ownership assertions. What they must guarantee: a stranger reading a row
 * gets the same NOT_FOUND as for a missing row (no existence leak); a
 * mutation may say FORBIDDEN only because the procedure chose it; and after
 * the call the row is non-null, typed, with no `!`.
 */
import { call, createORPCErrorConstructorMap, ORPCError, os } from '@orpc/server';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import { errorMap, reviveRpcError } from '@arki/failure/orpc';

import { AccessDenied, AUTH_FAILURES, ResourceMissing } from './boundary-failures.js';
import { assertFound, assertOwnedOrForbidden, assertOwnedOrNotFound } from './orpc.js';

type StoryRow = { readonly id: `sty_${string}`; readonly userId: `usr_${string}`; readonly title: string };

const errors = createORPCErrorConstructorMap(errorMap(...AUTH_FAILURES));

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
    assertOwnedOrNotFound(row, 'usr_me', errors);
    expectTypeOf(row).toEqualTypeOf<StoryRow>();
    expect(row.title).toBe('The Lighthouse');
  });

  it("someone else's row and a missing row look the same: NOT_FOUND with the same message", () => {
    const stranger = () => assertOwnedOrNotFound(mine, 'usr_stranger', errors);
    const missing = () => assertOwnedOrNotFound(null, 'usr_stranger', errors);
    expect(codeOf(stranger)).toBe('auth.not_found');
    expect(codeOf(missing)).toBe('auth.not_found');
    expect(stranger).toThrow('Resource not found.');
    expect(missing).toThrow('Resource not found.');
  });
});

describe('assertOwnedOrForbidden (mutations)', () => {
  it('missing → NOT_FOUND, not yours → FORBIDDEN, yours → passes', () => {
    expect(codeOf(() => assertOwnedOrForbidden(undefined, 'usr_me', errors))).toBe('auth.not_found');
    expect(codeOf(() => assertOwnedOrForbidden(mine, 'usr_stranger', errors))).toBe('auth.forbidden');
    expect(codeOf(() => assertOwnedOrForbidden(mine, 'usr_me', errors))).toBeNull();
  });
});

describe('assertFound (rows a getOwned query already scoped to the caller)', () => {
  it('missing → NOT_FOUND; anything else passes, narrowed', () => {
    const row: StoryRow | undefined = mine;
    expect(codeOf(() => assertFound(null, errors))).toBe('auth.not_found');
    assertFound(row, errors);
    expectTypeOf(row).toEqualTypeOf<StoryRow>();
  });

  it('only rows with an owner reach the ownership checks', () => {
    // @ts-expect-error a row without `userId` cannot be checked for ownership
    expect(() => assertOwnedOrNotFound({ id: 'x' }, 'usr_me', errors)).toThrow();
  });
});

it('ownership assertions use the procedure declaration and revive canonical missing failures', async () => {
  const procedure = os
    .errors(errorMap(ResourceMissing, AccessDenied))
    .input(z.string())
    .handler(({ errors, input }) => {
      const row = new Map<string, StoryRow>().get(input);
      assertOwnedOrForbidden(row, 'usr_me', errors);
      return row.title;
    });
  const error: unknown = await call(procedure, 'missing').catch((error_: unknown) => error_);
  expect(ResourceMissing.is(reviveRpcError(error, AUTH_FAILURES))).toBe(true);
});
