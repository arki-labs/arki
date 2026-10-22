import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type { StandardSchemaV1 } from '@standard-schema/spec';

import type { DataOf, Failure, FailureOf, Stoppable, SuccessOf } from './failure.js';
import { FAILURE_ERROR_CODES } from './errors.js';
import { defineFailure, isFailure, orThrow, stoppable, UnexpectedFailure } from './failure.js';

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
      return [
        // @ts-expect-error -- data is required when the definition has a schema
        PostNotFound(),
        // @ts-expect-error -- the data must match the schema
        PostNotFound({ id: 1 }),
        // @ts-expect-error -- a definition without a schema takes no data
        Unauthorized({ id: 'x' }),
      ];
    };
    expectTypeOf(mustNotCompile).toBeFunction();
  });

  // Otherwise every exported failure prints `z.ZodObject<…>` into its package's .d.ts, tying consumers to Zod.
  it('a definition names its schema by input and output only, never the schema library', () => {
    const Moved = defineFailure('post.moved', { data: z.object({ to: z.string().transform(Number) }) });
    expectTypeOf(Moved.dataSchema).toEqualTypeOf<StandardSchemaV1<{ to: string }, { to: number }>>();
    expectTypeOf(defineFailure('post.gone').dataSchema).toEqualTypeOf<undefined>();
  });

  it('types data as the schema output: a failure carries the live value, not the wire form', () => {
    const Expired = defineFailure('token.expired', {
      status: 401,
      data: z.object({ at: z.union([z.string(), z.date()]).transform(value => new Date(value)) }),
    });
    expectTypeOf<DataOf<typeof Expired.dataSchema>>().toEqualTypeOf<{ at: Date }>();
    expectTypeOf(Expired).parameter(0).toEqualTypeOf<{ at: Date }>();
    const at = new Date('2026-10-16T00:00:00Z');
    expect(Expired({ at }).data.at).toBe(at);
  });
});

describe('isFailure', () => {
  it('never takes outside data for a failure, even with the brand key in it', () => {
    // An API response or queue message is attacker-shaped JSON. If it passed as a failure,
    // boundaries would skip output schemas and answer with its status and code.
    const forged = JSON.parse('{"~failure":true,"code":"x","message":"m","status":500,"data":{}}') as unknown;
    expect(isFailure(forged)).toBe(false);
    expect(isFailure({ '~failure': true, code: 'x' })).toBe(false);
    expect(isFailure({ ...PostNotFound({ id: 'x' }) })).toBe(false);
  });

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

// WHY: a partial success keeps what was delivered before the failure. If the caller had to
// write `'stoppedBy' in result` to read the failure, it would be easy to skip; with Stoppable
// the field is always readable and typed, so the check is a plain `if (result.stoppedBy)`.
describe('Stoppable', () => {
  const TokenRefused = defineFailure('push.token_refused', { status: 422 });
  const push = async (
    items: readonly string[],
  ): Promise<Stoppable<{ delivered: string[] }, Failure<'push.token_refused', undefined>>> => {
    await Promise.resolve(); // stands in for the network
    const delivered: string[] = [];
    for (const item of items) {
      if (item === 'refused') return { delivered, stoppedBy: TokenRefused() };
      delivered.push(item);
    }
    return { delivered };
  };

  it('reads stoppedBy without narrowing: the failure, or undefined', async () => {
    const result = await push(['a', 'refused', 'b']);
    expectTypeOf(result.stoppedBy).toEqualTypeOf<Failure<'push.token_refused', undefined> | undefined>();
    expect(result.delivered).toEqual(['a']);
    expect(TokenRefused.is(result.stoppedBy)).toBe(true);
    const finished = await push(['a']);
    expect(finished.stoppedBy).toBeUndefined();
  });

  it('is the value itself, not a wrapper', () => {
    expectTypeOf<Stoppable<{ delivered: string[] }, Failure>>().toExtend<{ delivered: string[] }>();
  });
});

// WHY: a partial-success function should not restate its own return type. If `stoppable` did not
// carry the failure into the type, each such function would need a hand-written
// `Promise<Stoppable<...>>` annotation that drifts from the failures it really returns.
describe('stoppable', () => {
  const ExportUnauthorized = defineFailure('export.unauthorized', { status: 422 });
  const exportAll = async (refused: boolean) => {
    await Promise.resolve(); // stands in for the network
    if (refused) return stoppable({ delivered: 3 }, ExportUnauthorized());
    return stoppable({ delivered: 3 });
  };

  it('infers the Stoppable from its branches, with no annotation', () => {
    expectTypeOf(exportAll).returns.resolves.toEqualTypeOf<
      Stoppable<{ delivered: number }, Failure<'export.unauthorized', undefined>>
    >();
    expectTypeOf(stoppable({ delivered: 3 })).toEqualTypeOf<Stoppable<{ delivered: number }, never>>();
  });

  it('puts the failure in stoppedBy, and adds no stoppedBy key when there is none', async () => {
    const stopped = await exportAll(true);
    expect(stopped.delivered).toBe(3);
    expect(ExportUnauthorized.is(stopped.stoppedBy)).toBe(true);
    const finished = await exportAll(false);
    expect(finished).toEqual({ delivered: 3 });
    expect(Object.hasOwn(finished, 'stoppedBy')).toBe(false);
  });

  it('copies the value, so the caller can change the result without touching what it passed', () => {
    const value = { delivered: 3 };
    const result = stoppable(value);
    expect(result).not.toBe(value);
    expect(result).toEqual(value);
  });
});
