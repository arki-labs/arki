import { ORPCError as ClientORPCError } from '@orpc/client';
import { oc } from '@orpc/contract';
import { call, implement, ORPCError } from '@orpc/server';
import ts from 'typescript';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type { Failure } from './failure.js';
import type { RevivalFailure } from './revive.js';
import { FAILURE_ERROR_CODES } from './errors.js';
import { defineFailure, isFailure } from './failure.js';
import { InvalidEnvelope } from './foundations.js';
import { match } from './handle.js';
import { errorMap, orThrowRpc, reviveRpcError, RPC_FAILURE_DEFINITION, rpcFailureDefinitions } from './orpc.js';

const PostNotFound = defineFailure('post.not_found', {
  status: 404,
  data: z.object({ id: z.string() }),
  message: 'no post {id}',
});
const PostLocked = defineFailure('post.locked', { status: 409 });
const Unlisted = defineFailure('post.unlisted', { status: 403 });

const PostSchema = z.object({ id: z.string(), title: z.string() });
type Post = z.infer<typeof PostSchema>;

const posts = new Map<string, Post>([['p1', { id: 'p1', title: 'Hello' }]]);
const find = async (id: string) => {
  await Promise.resolve(); // stands in for the repository read
  if (id === 'locked') return PostLocked();
  return posts.get(id) ?? PostNotFound({ id });
};
/** A usecase that grew a failure the contract below does not list yet. */
const findListed = async (id: string) => (id === 'unlisted' ? Unlisted() : find(id));

/** The contract lists the failures by definition: code, status and data schema are written once, in defineFailure. */
const byId = oc
  .errors(errorMap(PostNotFound, PostLocked))
  .input(z.object({ id: z.string() }))
  .output(PostSchema);

const procedure = implement(byId).handler(({ input, errors }) => orThrowRpc(find(input.id), errors));

describe('errorMap', () => {
  it('builds the oRPC error map from the definitions', () => {
    expect(errorMap(PostNotFound, PostLocked)).toEqual({
      'post.not_found': {
        status: 404,
        [RPC_FAILURE_DEFINITION]: PostNotFound,
        data: expect.objectContaining({ '~standard': expect.objectContaining({ vendor: 'arki/failure' }) }),
      },
      'post.locked': { status: 409, [RPC_FAILURE_DEFINITION]: PostLocked },
    });
  });

  it('preserves canonical definitions through native contracts without exposing them in JSON', () => {
    const definitions = rpcFailureDefinitions(byId['~orpc'].errorMap);
    expect(definitions).toEqual([PostNotFound, PostLocked]);
    expectTypeOf(definitions).toEqualTypeOf<(typeof PostNotFound | typeof PostLocked)[]>();
    const copied = { ...byId['~orpc'].errorMap['post.not_found'] };
    expect(copied[RPC_FAILURE_DEFINITION]).toBe(PostNotFound);
    const wire = JSON.stringify(copied);
    expect(JSON.parse(wire)).not.toHaveProperty(String(RPC_FAILURE_DEFINITION));
    expect(reviveRpcError(new ORPCError(PostNotFound.code, { data: { id: 'p2' } }), definitions)).toEqual(
      PostNotFound({ id: 'p2' }),
    );
    expect(rpcFailureDefinitions({ external: { status: 500 } })).toEqual([]);
    const mixed = oc.errors({ ...errorMap(PostNotFound), external: { status: 500 } });
    const mixedDefinitions = rpcFailureDefinitions(mixed['~orpc'].errorMap);
    expect(mixedDefinitions).toEqual([PostNotFound]);
    expectTypeOf(mixedDefinitions).toEqualTypeOf<(typeof PostNotFound)[]>();
    const optional: Record<string, { status: number; [RPC_FAILURE_DEFINITION]?: typeof PostNotFound }> =
      errorMap(PostNotFound);
    const optionalDefinitions = rpcFailureDefinitions(optional);
    expect(optionalDefinitions).toEqual([PostNotFound]);
    expectTypeOf(optionalDefinitions).toEqualTypeOf<(typeof PostNotFound)[]>();
    expectTypeOf(rpcFailureDefinitions({ external: { data: z.string() } })).toEqualTypeOf<never[]>();
  });

  it('refuses two definitions with one code, which would make one of them unreachable', () => {
    const Twin = defineFailure('post.locked', { status: 423 });
    expect(() => errorMap(PostLocked, Twin)).toThrow(
      expect.objectContaining({ code: FAILURE_ERROR_CODES.duplicateCode }),
    );
  });
});

describe('orThrowRpc in a procedure', () => {
  it('returns the success value', async () => {
    await expect(call(procedure, { id: 'p1' })).resolves.toEqual({ id: 'p1', title: 'Hello' });
  });

  it('throws the declared, typed ORPCError the client can match on', async () => {
    const error = await call(procedure, { id: 'nope' }).catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({
      code: 'post.not_found',
      status: 404,
      message: 'no post nope',
      data: { id: 'nope' },
      defined: true,
    });
    await expect(call(procedure, { id: 'locked' })).rejects.toMatchObject({ code: 'post.locked', defined: true });
  });

  // Observers on the server (error reporters, handler events) need the failure itself; the client must not get it twice.
  it('keeps the failure as the error cause on the server, and out of what the client receives', async () => {
    const error = await call(procedure, { id: 'nope' }).catch((error_: unknown) => error_);
    if (!(error instanceof ORPCError)) throw new Error('expected an ORPCError');
    expect(isFailure(error.cause)).toBe(true);
    expect(error.cause).toMatchObject({ code: 'post.not_found', data: { id: 'nope' } });
    expect(Object.keys(error.toJSON())).not.toContain('cause');
  });

  it('makes a failure the contract does not list a compile error, so the client never meets an untyped error', () => {
    const compileOnly = () =>
      implement(byId).handler(({ input, errors }) =>
        // @ts-expect-error -- 'post.unlisted' is missing from the contract's errors
        orThrowRpc(findListed(input.id), errors),
      );
    expect(compileOnly).toBeTypeOf('function');
  });

  it('still throws an undeclared ORPCError when the types were bypassed, so the gap stays visible', async () => {
    const loose: Record<string, never> = {};
    const bypassed = implement(byId).handler(({ input }) => orThrowRpc(findListed(input.id), loose as never));
    await expect(call(bypassed, { id: 'unlisted' })).rejects.toMatchObject({
      code: 'post.unlisted',
      status: 403,
      defined: false,
    });
  });

  it('makes forgetting orThrowRpc a compile error: a failure is not the output', () => {
    // @ts-expect-error -- Post | Failure is not assignable to the output Post
    implement(byId).handler(({ input }) => find(input.id));
    implement(byId).handler(({ input, errors }) => {
      expectTypeOf(orThrowRpc(find(input.id), errors)).toEqualTypeOf<Promise<Post>>();
      return orThrowRpc(find(input.id), errors);
    });
  });
});

// WHY: a usecase that returns nothing or a failure (delete, disconnect) still needs a fixed
// success answer. The third argument keeps that one expression, so the handler cannot drop the
// failure check on the way to `return { success: true }`.
describe('orThrowRpc with a success answer', () => {
  const remove = async (id: string) => {
    await Promise.resolve(); // stands in for the repository delete
    if (id === 'locked') return PostLocked();
    return posts.has(id) ? undefined : PostNotFound({ id });
  };
  /** A delete that grew a failure the contract does not list yet. */
  const removeUnlisted = async (id: string) => (id === 'unlisted' ? Unlisted() : remove(id));
  const removeById = oc
    .errors(errorMap(PostNotFound, PostLocked))
    .input(z.object({ id: z.string() }))
    .output(z.object({ success: z.literal(true) }));
  const removeProcedure = implement(removeById).handler(({ input, errors }) =>
    orThrowRpc(remove(input.id), errors, { success: true }),
  );

  it('answers the success value when the usecase returned nothing', async () => {
    await expect(call(removeProcedure, { id: 'p1' })).resolves.toEqual({ success: true });
  });

  it('still throws the declared failure instead of answering success', async () => {
    await expect(call(removeProcedure, { id: 'nope' })).rejects.toMatchObject({
      code: 'post.not_found',
      status: 404,
      defined: true,
    });
    await expect(call(removeProcedure, { id: 'locked' })).rejects.toMatchObject({ code: 'post.locked' });
  });

  it('works on a value that is already awaited', () => {
    const errors = {
      'post.not_found': () => new Error('not found'),
      'post.locked': () => new Error('locked'),
    };
    expect(orThrowRpc(undefined, errors, 'done')).toBe('done');
    expect(() => orThrowRpc(PostLocked(), errors, 'done')).toThrow('locked');
  });

  it('is typed as the success answer, and still checks the contract lists every failure', () => {
    implement(removeById).handler(async ({ input, errors }) => {
      expectTypeOf(orThrowRpc(remove(input.id), errors, { success: true as const })).toEqualTypeOf<
        Promise<{ success: true }>
      >();
      expectTypeOf(orThrowRpc(await remove(input.id), errors, 0)).toEqualTypeOf<number>();
      return orThrowRpc(await remove(input.id), errors, { success: true });
    });
    const compileOnly = () =>
      implement(removeById).handler(({ input, errors }) =>
        // @ts-expect-error -- 'post.unlisted' is missing from the contract's errors
        orThrowRpc(removeUnlisted(input.id), errors, { success: true }),
      );
    expect(compileOnly).toBeTypeOf('function');
  });
});

/** What the frontend does: call, catch, and get the declared failure back as a value. */
const fetchPost = async (id: string) => {
  try {
    return await call(procedure, { id });
  } catch (error) {
    const failure = reviveRpcError(error, [PostNotFound, PostLocked]);
    if (failure === undefined) throw error;
    return failure;
  }
};

describe('reviveRpcError on the client', () => {
  it('turns the declared ORPCError back into the live failure, so the frontend can match on it like the backend', async () => {
    const result = await fetchPost('nope');
    expect(isFailure(result)).toBe(true);
    expect(PostNotFound.is(result)).toBe(true);
    expect(result).toMatchObject({
      code: 'post.not_found',
      status: 404,
      message: 'no post nope',
      data: { id: 'nope' },
    });
    const label = match(result, {
      ...protocolHandlers,
      ok: post => post.title,
      'post.not_found': failure => `missing ${failure.data.id}`,
      'post.locked': () => 'locked',
    });
    expect(label).toBe('missing nope');
    expect(
      match(await fetchPost('locked'), {
        ...protocolHandlers,
        ok: () => 'ok',
        'post.not_found': () => 'missing',
        'post.locked': () => 'locked',
      }),
    ).toBe('locked');
  });

  it('types the result from the definitions passed, so a match must handle exactly those codes', async () => {
    const result = await fetchPost('p1');
    expectTypeOf(result).toEqualTypeOf<
      Post | Failure<'post.not_found', { id: string }> | Failure<'post.locked', undefined> | RevivalFailure
    >();
    expect(result).toEqual({ id: 'p1', title: 'Hello' });
  });

  it('returns undefined for errors it was not told about, so unknown errors stay thrown as bugs', async () => {
    const locked = await call(procedure, { id: 'locked' }).catch((error_: unknown) => error_);
    expect(reviveRpcError(locked, [PostNotFound])).toMatchObject({ data: { reason: 'unknown_code' } });
    expect(reviveRpcError(new TypeError('network down'), [PostNotFound])).toBeUndefined();
    // A plain object that only looks like the error is JSON, not a caught ORPCError: that is revive's job.
    expect(reviveRpcError({ code: 'post.not_found', data: { id: 'x' } }, [PostNotFound])).toBeUndefined();
  });

  it('refuses data that does not match the schema, so a server and client on different definitions fail loudly', () => {
    const drifted = new ORPCError('post.not_found', { status: 404, data: { id: 42 } });
    expect(InvalidEnvelope.is(reviveRpcError(drifted, [PostNotFound]))).toBe(true);
  });
});

describe('browser safety', () => {
  it('imports nothing from @orpc/server, because contract files and client code that use this entry ship to browsers', () => {
    const source = ts.sys.readFile(new URL('orpc.ts', import.meta.url).pathname);
    expect(source).toBeDefined();
    const imports = ts.preProcessFile(source ?? '').importedFiles.map(file => file.fileName);
    expect(imports).toContain('@orpc/client');
    expect(imports).not.toContain('@orpc/server');
  });

  it('throws the same ORPCError class the server checks, so declared failures still reach the client as defined', () => {
    expect(ClientORPCError).toBe(ORPCError);
  });
});

const protocolHandlers = {
  'failure.invalid_envelope': () => 'invalid envelope',
  'schema.async_required': () => 'async schema',
  'schema.validator_defect': () => 'validator defect',
  'failure.unexpected_defect': () => 'unexpected defect',
};
