import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type { Failure, FailureOf, SuccessOf } from './failure.js';
import { FAILURE_ERROR_CODES } from './errors.js';
import { defineFailure, isFailure, orThrow, UnexpectedFailure } from './failure.js';

const PostNotFound = defineFailure('post.not_found', {
  status: 404,
  data: z.object({ id: z.string() }),
  message: 'no post {id}',
  remediation: 'Check the id; the post may have been deleted.',
});
const Unauthorized = defineFailure('auth.unauthorized', { status: 401 });

type Post = { id: string; title: string };
const posts = new Map<string, Post>([['p1', { id: 'p1', title: 'Hello' }]]);

/** A usecase written the way apps write them: plain async, the failure is just returned. */
const find = async (id: string) => (await Promise.resolve(posts.get(id))) ?? PostNotFound({ id });

describe('defineFailure', () => {
  it('makes failures that carry everything a boundary needs, from one definition', () => {
    const failure = PostNotFound({ id: 'x' });
    expect(failure).toMatchObject({
      code: 'post.not_found',
      message: 'no post x',
      data: { id: 'x' },
      status: 404,
      remediation: 'Check the id; the post may have been deleted.',
    });
    expect(Object.isFrozen(failure)).toBe(true);
  });

  it('fills the message template from the data, and checks its placeholders at compile time', () => {
    const Moved = defineFailure('post.moved', {
      data: z.object({ id: z.string(), to: z.string() }),
      message: 'post {id} moved to {to}',
    });
    expect(Moved({ id: 'a', to: 'b' }).message).toBe('post a moved to b');
    const typeOnly = () =>
      // @ts-expect-error -- {slug} is not a key of the data
      defineFailure('post.bad', { data: z.object({ id: z.string() }), message: 'no post {slug}' });
    expectTypeOf(typeOnly).toBeFunction();
  });

  it('builds the message with a function when a template is not enough', () => {
    const TooMany = defineFailure('cart.too_many', {
      data: z.object({ count: z.number() }),
      message: ({ count }) => `${String(count)} items is over the limit`,
    });
    expect(TooMany({ count: 3 }).message).toBe('3 items is over the limit');
  });

  it('defaults to status 400 and the code as message, and takes no data without a schema', () => {
    const BadInput = defineFailure('input.bad');
    expect(BadInput()).toMatchObject({ code: 'input.bad', message: 'input.bad', status: 400, data: undefined });
    expect(Unauthorized().status).toBe(401);
  });

  it('keeps a cause for findCause and debugging, without putting it in the JSON', () => {
    const lower = new Error('socket closed');
    expect(PostNotFound({ id: 'x' }, { cause: lower }).cause).toBe(lower);
    expect(Unauthorized({ cause: lower }).cause).toBe(lower);
    expect(JSON.stringify(Unauthorized({ cause: lower }))).not.toContain('socket');
  });

  it('serialises to plain JSON (logs, queues), without the brand', () => {
    const failure = PostNotFound({ id: 'x' });
    expect(JSON.stringify(failure)).toBe(
      '{"code":"post.not_found","message":"no post x","data":{"id":"x"},"status":404,' +
        '"remediation":"Check the id; the post may have been deleted."}',
    );
    expect(Object.keys({ ...failure })).toEqual(['code', 'message', 'data', 'status', 'remediation']);
  });

  it('rejects codes and statuses that would break a boundary', () => {
    // "ok" would collide with the success handler of match().
    expect(() => defineFailure('ok')).toThrow(expect.objectContaining({ code: FAILURE_ERROR_CODES.invalidCode }));
    expect(() => defineFailure('')).toThrow(expect.objectContaining({ code: FAILURE_ERROR_CODES.invalidCode }));
    // oRPC and HTTP refuse a 2xx/3xx error: a failure is never a success.
    expect(() => defineFailure('x', { status: 200 })).toThrow(
      expect.objectContaining({ code: FAILURE_ERROR_CODES.invalidStatus }),
    );
    expect(() => defineFailure('x', { status: 404.5 })).toThrow(
      expect.objectContaining({ code: FAILURE_ERROR_CODES.invalidStatus }),
    );
  });

  it('is() recognises its own failures only', () => {
    expect(PostNotFound.is(PostNotFound({ id: 'x' }))).toBe(true);
    expect(PostNotFound.is(Unauthorized())).toBe(false);
    expect(PostNotFound.is({ code: 'post.not_found' })).toBe(false);
  });

  it('types the data from the schema, written once', () => {
    expectTypeOf(PostNotFound({ id: 'x' }).data).toEqualTypeOf<{ id: string }>();
    expectTypeOf(Unauthorized().data).toEqualTypeOf<undefined>();
    // Compile-time only: these calls must not type-check, so they are never run.
    const mustNotCompile = () => {
      // @ts-expect-error -- data is required when the definition has a schema
      PostNotFound();
      // @ts-expect-error -- the data must match the schema
      PostNotFound({ id: 1 });
      // @ts-expect-error -- a definition without a schema takes no data
      Unauthorized({ id: 'x' });
    };
    expectTypeOf(mustNotCompile).toBeFunction();
  });
});

describe('isFailure', () => {
  it('tells a failure from a success value, even one that looks the same', () => {
    expect(isFailure(PostNotFound({ id: 'x' }))).toBe(true);
    expect(isFailure({ code: 'post.not_found', message: '', data: {}, status: 404 })).toBe(false);
    const json = JSON.stringify(PostNotFound({ id: 'x' }));
    expect(isFailure(JSON.parse(json) as unknown)).toBe(false);
    expect(isFailure(null)).toBe(false);
    expect(isFailure('post.not_found')).toBe(false);
  });

  it('makes the compiler force a check before the success value is used', async () => {
    const result = await find('p1');
    expectTypeOf(result).toEqualTypeOf<Post | Failure<'post.not_found', { id: string }>>();
    // @ts-expect-error -- the failure has no title: the caller must check first
    void result.title;
    if (isFailure(result)) {
      expectTypeOf(result.code).toEqualTypeOf<'post.not_found'>();
      expectTypeOf(result.data).toEqualTypeOf<{ id: string }>();
    } else {
      expectTypeOf(result).toEqualTypeOf<Post>();
      expect(result.title).toBe('Hello');
    }
  });

  it('refuses a promise at compile time: a forgotten await would always say "not a failure"', () => {
    const typeOnly = () => {
      // @ts-expect-error -- await the value first
      isFailure(find('p1'));
    };
    expectTypeOf(typeOnly).toBeFunction();
  });

  it('finds the failures and the success of a function from its return type', () => {
    expectTypeOf<FailureOf<typeof find>>().toEqualTypeOf<Failure<'post.not_found', { id: string }>>();
    expectTypeOf<SuccessOf<typeof find>>().toEqualTypeOf<Post>();
  });
});

describe('orThrow', () => {
  it('returns the success value with the failure removed from the type', async () => {
    const post = orThrow(await find('p1'));
    expectTypeOf(post).toEqualTypeOf<Post>();
    expect(post.title).toBe('Hello');
  });

  it('throws an UnexpectedFailure, keeping the failure and its cause', async () => {
    const cause = new Error('db down');
    const thrown = await Promise.resolve(PostNotFound({ id: 'm' }, { cause }))
      .then(orThrow)
      .catch((error_: unknown) => error_);
    expect(thrown).toBeInstanceOf(UnexpectedFailure);
    expect(thrown).toMatchObject({ code: 'post.not_found', status: 404, failure: { data: { id: 'm' } }, cause });
  });

  it('takes a promise, so a forgotten await cannot slip a failure through', async () => {
    const pending = orThrow(find('p1'));
    expectTypeOf(pending).toEqualTypeOf<Promise<Post>>();
    expect(await pending).toEqual({ id: 'p1', title: 'Hello' });
    await expect(orThrow(find('missing'))).rejects.toBeInstanceOf(UnexpectedFailure);
  });
});
