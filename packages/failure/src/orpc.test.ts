import { oc } from '@orpc/contract';
import { call, implement, ORPCError } from '@orpc/server';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import { FAILURE_ERROR_CODES } from './errors.js';
import { defineFailure } from './failure.js';
import { errorMap, orThrowRpc } from './orpc.js';

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
  if (id === 'unlisted') return Unlisted();
  return posts.get(id) ?? PostNotFound({ id });
};

/** The contract lists the failures by definition: code, status and data schema are written once, in defineFailure. */
const byId = oc
  .errors(errorMap(PostNotFound, PostLocked))
  .input(z.object({ id: z.string() }))
  .output(PostSchema);

const procedure = implement(byId).handler(({ input }) => orThrowRpc(find(input.id)));

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

  it('marks a failure the contract does not declare as undeclared, so it is visible, not silently typed', async () => {
    await expect(call(procedure, { id: 'unlisted' })).rejects.toMatchObject({
      code: 'post.unlisted',
      status: 403,
      defined: false,
    });
  });

  it('makes forgetting orThrowRpc a compile error: a failure is not the output', () => {
    // @ts-expect-error -- Post | Failure is not assignable to the output Post
    implement(byId).handler(({ input }) => find(input.id));
    expectTypeOf(orThrowRpc(find('p1'))).toEqualTypeOf<Promise<Post>>();
  });
});
