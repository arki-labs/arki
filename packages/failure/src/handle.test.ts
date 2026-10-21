import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';

import type { Failure } from './failure.js';
import { FAILURE_ERROR_CODES, FailureError } from './errors.js';
import { defineFailure } from './failure.js';
import { invariant, match, recover, unreachable } from './handle.js';

const PostNotFound = defineFailure('post.not_found', { status: 404, data: z.object({ id: z.string() }) });
const PostLocked = defineFailure('post.locked', { status: 409 });

type Post = { id: string; title: string };
type Loaded = Post | ReturnType<typeof PostNotFound> | ReturnType<typeof PostLocked>;

function load(id: string): Loaded {
  if (id === 'missing') return PostNotFound({ id });
  if (id === 'locked') return PostLocked();
  return { id, title: 'Hello' };
}

const onlyPost = (): Post => ({ id: 'p', title: 't' });

/** A value that can only be a failure, like the client's after `reviveRpcError`. */
const loadFailure = (id: string): Exclude<Loaded, Post> => (id === 'missing' ? PostNotFound({ id }) : PostLocked());

const describeLoad = (id: string) =>
  match(load(id), {
    ok: post => `title ${post.title}`,
    'post.not_found': failure => `missing ${failure.data.id}`,
    'post.locked': () => 'locked',
  });

describe('match', () => {
  it('runs the handler of the branch the value is on', () => {
    expect(describeLoad('p1')).toBe('title Hello');
    expect(describeLoad('missing')).toBe('missing missing');
    expect(describeLoad('locked')).toBe('locked');
  });

  it('infers the union of what the handlers return', () => {
    const out = match(load('p1'), { ok: () => 1, 'post.not_found': () => 'none', 'post.locked': () => null });
    expectTypeOf(out).toEqualTypeOf<number | string | null>();
  });

  it('makes a missing handler a compile error, so a new failure updates every caller', () => {
    // @ts-expect-error -- 'post.locked' is not handled
    match(load('p1'), { ok: () => 1, 'post.not_found': () => 2 });
  });

  it('makes a handler for a failure that can no longer happen a compile error', () => {
    // @ts-expect-error -- 'post.locked' cannot come out of onlyPost(): a stale handler
    match(onlyPost(), { ok: () => 1, 'post.locked': () => 2 });
  });

  it('still requires ok when the value can be a success', () => {
    // @ts-expect-error -- load() can return a post, so `ok` is required
    match(load('missing'), { 'post.not_found': () => 1, 'post.locked': () => 2 });
  });

  it('takes one handler per code and no ok for a value that can only be a failure, as on the client after reviveRpcError', () => {
    const failed = loadFailure('missing');
    const out = match(failed, { 'post.not_found': failure => failure.data.id, 'post.locked': () => null });
    expectTypeOf(out).toEqualTypeOf<string | null>();
    expect(out).toBe('missing');
    // @ts-expect-error -- 'post.locked' is not handled: exhaustiveness still holds
    match(failed, { 'post.not_found': () => 1 });
    // @ts-expect-error -- `ok` can never run for a failure-only value: a stale handler
    match(failed, { ok: () => 0, 'post.not_found': () => 1, 'post.locked': () => 2 });
  });

  it('fails loud when the types were bypassed and a handler is missing at runtime', () => {
    // Typed as unknown, the value seems to need only `ok`; at runtime it is a failure.
    expect(() => match<unknown, { ok: () => number }>(PostLocked(), { ok: () => 1 })).toThrow(
      expect.objectContaining({ code: FAILURE_ERROR_CODES.unhandledFailure }),
    );
  });
});

describe('recover', () => {
  it('handles the listed failures and passes the rest through unchanged', () => {
    const fallback = { id: 'draft', title: 'Draft' };
    expect(recover(load('locked'), { 'post.locked': () => fallback })).toBe(fallback);
    const missing = load('missing');
    expect(recover(missing, { 'post.locked': () => fallback })).toBe(missing);
    expect(recover(load('p1'), { 'post.locked': () => fallback })).toEqual({ id: 'p1', title: 'Hello' });
  });

  it('drops the handled codes from the type, so the compiler knows what is still possible', () => {
    const partly = recover(load('x'), { 'post.locked': () => 'read-only' as const });
    expectTypeOf(partly).toEqualTypeOf<Post | 'read-only' | Failure<'post.not_found', { id: string }>>();
    const fully = recover(load('x'), { 'post.locked': () => null, 'post.not_found': failure => failure.data.id });
    expectTypeOf(fully).toEqualTypeOf<Post | null | string>();
  });

  it('makes a handler for a code the value cannot carry a compile error', () => {
    // @ts-expect-error -- 'post.gone' is not a failure of load()
    recover(load('x'), { 'post.gone': () => 1 });
  });
});

describe('unreachable', () => {
  type Shape = { kind: 'circle'; r: number } | { kind: 'square'; side: number };
  const area = (shape: Shape): number => {
    switch (shape.kind) {
      case 'circle': {
        return Math.PI * shape.r ** 2;
      }
      case 'square': {
        return shape.side ** 2;
      }
      default: {
        return unreachable(shape);
      }
    }
  };

  it('compiles only when every member is handled, and throws a coded error if reached anyway', () => {
    expect(area({ kind: 'square', side: 2 })).toBe(4);
    const smuggled = JSON.parse('{"kind":"triangle"}') as Shape;
    expect(() => area(smuggled)).toThrow(expect.objectContaining({ code: FAILURE_ERROR_CODES.unreachable }));
  });
});

describe('unreachable message', () => {
  it('never contains the value, because the value may be a secret that reached a switch from outside', () => {
    const secret = 'sk-live-do-not-print';
    const error = catchError(() => unreachable(JSON.parse(`"${secret}"`) as never));
    expect(error).toBeInstanceOf(FailureError);
    expect(String(error instanceof Error ? error.message : error)).not.toContain(secret);
  });

  it('uses the caller message when given', () => {
    expect(() => unreachable(undefined as never, 'unknown plan')).toThrow('unknown plan');
  });
});

describe('invariant', () => {
  it('passes a truthy condition and throws a coded FailureError on a falsy one, because a broken invariant is a bug, not an expected failure', () => {
    expect(() => {
      invariant(1 + 1 === 2);
    }).not.toThrow();
    expect(() => {
      invariant(null, 'user must be loaded');
    }).toThrow(expect.objectContaining({ code: FAILURE_ERROR_CODES.invariant }));
  });

  it('builds a lazy message only on failure', () => {
    const build = vi.fn(() => 'expensive');
    invariant(true, build);
    expect(build).not.toHaveBeenCalled();
    expect(() => {
      invariant(false, build);
    }).toThrow('expensive');
    expect(build).toHaveBeenCalledTimes(1);
  });
});

/** The error a callback throws, or undefined. */
function catchError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}
