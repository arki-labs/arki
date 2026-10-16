import { ORPCError as ClientORPCError } from '@orpc/client';
import { oc } from '@orpc/contract';
import { call, implement, ORPCError } from '@orpc/server';
import ts from 'typescript';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type { Failure } from './failure.js';
import { FAILURE_ERROR_CODES } from './errors.js';
import { defineFailure, isFailure } from './failure.js';
import { match } from './handle.js';
import { errorMap, orThrowRpc, reviveRpcError } from './orpc.js';

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
      'post.not_found': { status: 404, data: PostNotFound.dataSchema },
      'post.locked': { status: 409 },
    });
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
      ok: post => post.title,
      'post.not_found': failure => `missing ${failure.data.id}`,
      'post.locked': () => 'locked',
    });
    expect(label).toBe('missing nope');
    expect(
      match(await fetchPost('locked'), {
        ok: () => 'ok',
        'post.not_found': () => 'missing',
        'post.locked': () => 'locked',
      }),
    ).toBe('locked');
  });

  it('types the result from the definitions passed, so a match must handle exactly those codes', async () => {
    const result = await fetchPost('p1');
    expectTypeOf(result).toEqualTypeOf<
      Post | Failure<'post.not_found', { id: string }> | Failure<'post.locked', undefined>
    >();
    expect(result).toEqual({ id: 'p1', title: 'Hello' });
  });

  it('returns undefined for errors it was not told about, so unknown errors stay thrown as bugs', async () => {
    const locked = await call(procedure, { id: 'locked' }).catch((error_: unknown) => error_);
    expect(reviveRpcError(locked, [PostNotFound])).toBeUndefined();
    expect(reviveRpcError(new TypeError('network down'), [PostNotFound])).toBeUndefined();
    // A plain object that only looks like the error is JSON, not a caught ORPCError: that is revive's job.
    expect(reviveRpcError({ code: 'post.not_found', data: { id: 'x' } }, [PostNotFound])).toBeUndefined();
  });

  it('refuses data that does not match the schema, so a server and client on different definitions fail loudly', () => {
    const drifted = new ORPCError('post.not_found', { status: 404, data: { id: 42 } });
    expect(() => reviveRpcError(drifted, [PostNotFound])).toThrow(
      expect.objectContaining({ code: FAILURE_ERROR_CODES.invalidData }),
    );
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
