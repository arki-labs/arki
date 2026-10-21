import type { ContractRouterClient } from '@orpc/contract';
import { oc } from '@orpc/contract';
import type { GeneralUtils, ProcedureUtils } from '@orpc/tanstack-query';
import { describe, expectTypeOf, it } from 'vitest';

import type { Identified, OperationOf } from '@arki/contracts/orpc';
import { z } from '@arki/contracts';

import type { OrpcUtils } from './client';
import { createORPCReact, createOrpcUtils } from './client';

const postId = z.string().brand<'PostId'>();
const post = z.object({ id: postId, title: z.string() });
const contract = {
  posts: {
    get: oc.input(z.object({ id: postId })).output(post),
    create: oc.$meta({ offlineSafe: true as const }).input(post.omit({ id: true })).output(post),
  },
};
type Post = z.output<typeof post>;
type PostId = z.output<typeof postId>;

declare const client: ContractRouterClient<typeof contract>;

describe('createOrpcUtils', () => {
  const orpc = createOrpcUtils(contract, client);

  it('a leaf is oRPC ProcedureUtils, with no annotation and branded ids kept', () => {
    // Plain assignments: expect-type cannot compare oRPC's overloaded call signatures.
    const leaf: ProcedureUtils<Record<never, never>, { id: string }, Post, Error> = orpc.posts.get;
    expectTypeOf(leaf).not.toBeAny();
  });

  it('keeps branded ids branded in the output', async () => {
    const got = await orpc.posts.get.call({ id: 'p1' });
    const id: PostId = got.id;
    expectTypeOf(id).not.toBeAny();
  });

  it('a leaf carries its operation, meta included', () => {
    expectTypeOf(orpc.posts.create).toExtend<Identified<OperationOf<typeof contract.posts.create>>>();
    expectTypeOf(orpc.posts.create['~op'].meta.offlineSafe).toEqualTypeOf<true>();
  });

  it('a group keeps key() for partial invalidation, and has no operation', () => {
    expectTypeOf(orpc.posts).toExtend<GeneralUtils<unknown>>();
    expectTypeOf(orpc.posts).not.toHaveProperty('~op');
  });

  it('the result is exactly OrpcUtils of the contract', () => {
    const typed: OrpcUtils<typeof contract, Record<never, never>> = orpc;
    const back: typeof orpc = typed;
    expectTypeOf(back).not.toBeAny();
  });

  it('rejects a client for a different contract', () => {
    const other = { posts: { get: oc.input(z.object({ slug: z.string() })).output(post) } };
    // @ts-expect-error the client's input does not match this contract
    createOrpcUtils(other, client);
  });
});

describe('createORPCReact', () => {
  it('gives the same utils type as createOrpcUtils over a client it builds', () => {
    const { orpc } = createORPCReact(contract);
    const typed: OrpcUtils<typeof contract, Record<never, never>> = orpc;
    expectTypeOf(typed).not.toBeAny();
  });

  it('carries a custom client context into the utils', () => {
    const { orpc } = createORPCReact<typeof contract, { idempotencyKey?: string }>(contract, {
      headers: ({ context }) => {
        const headers: Record<string, string> = {};
        if (context?.idempotencyKey !== undefined) headers['Idempotency-Key'] = context.idempotencyKey;
        return headers;
      },
    });
    const typed: OrpcUtils<typeof contract, { idempotencyKey?: string }> = orpc;
    expectTypeOf(typed).not.toBeAny();
  });
});
