import type { MutationIdempotencyKey } from '../src/mutations/identity.ts';
import { orThrow } from '@arki/failure';
// The README's Tier 2 examples, compiled.
import { oc } from '@orpc/contract';
import type { ContractRouterClient } from '@orpc/contract';
import { implement } from '@orpc/server';
import { drizzle } from 'drizzle-orm/node-postgres';
import { expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import { OPERATION, operations } from '@arki/contracts/orpc';

import { useOfflineMutation } from '../src/mutations/hooks.ts';
import { IdempotencyRepository, idempotency, idempotencyKeys, offlineSafe } from '../src/orpc/index.ts';
import type { IdempotentContext } from '../src/orpc/index.ts';

const post = z.object({ id: z.string(), title: z.string() });
const createPostInput = post.omit({ id: true });

const postsRpcContract = {
  create: offlineSafe(oc.input(createPostInput).output(post)),
  list: oc.input(z.object({ cursor: z.string().optional() })).output(z.array(post)),
};
const rpcContract = { posts: postsRpcContract };

it('README: idempotency(repo) installed once on the implementer', () => {
  const db = drizzle.mock();
  const implementer = implement(rpcContract)
    .$context<IdempotentContext>()
    .use(idempotency(new IdempotencyRepository(db, idempotencyKeys)));
  // eslint-disable-next-line @typescript-eslint/unbound-method -- type-level check only; the handler is never detached or called
  expectTypeOf(implementer.posts.create.handler).toBeFunction();
});

it('README: useOfflineMutation(orpc.posts.create)', async () => {
  // What `createOrpcUtils(rpcContract, client)` gives each leaf; the hook reads only this.
  const orpc = { posts: { create: { [OPERATION]: operations(rpcContract).posts.create } } };
  const { mutate } = useOfflineMutation(orpc.posts.create);
  const { idempotencyKey } = orThrow(await mutate({ title: 'Hello' }));
  expectTypeOf(idempotencyKey).toEqualTypeOf<MutationIdempotencyKey>();
});

declare const client: ContractRouterClient<typeof rpcContract>;
void client;
