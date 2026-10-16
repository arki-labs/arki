import type { ContractRouterClient } from '@orpc/contract';
import { oc } from '@orpc/contract';
import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import { OPERATION, operations } from '@arki/contracts/orpc';

import type { OfflineMutationQueue } from '../../src/mutations/queue.ts';
import { useOfflineMutation } from '../../src/mutations/hooks.ts';
import { offlineSafe } from '../../src/orpc/offline-safe-marker.ts';

const createInput = z.object({ title: z.string(), at: z.string().transform(text => new Date(text)) });
const post = z.object({ id: z.string() });

const contract = {
  posts: {
    create: offlineSafe(oc.input(createInput).output(post)),
    plain: oc.input(createInput).output(post),
    optional: oc.$meta<{ offlineSafe?: true }>({}).input(createInput).output(post),
    off: oc.$meta<{ offlineSafe: false }>({ offlineSafe: false }).input(createInput).output(post),
  },
};

declare const client: ContractRouterClient<typeof contract>;
declare const queue: OfflineMutationQueue;
const ops = operations(contract);
/** What a `createOrpcUtils` leaf carries; the hooks read nothing else. */
const orpc = {
  posts: {
    create: { [OPERATION]: ops.posts.create },
    plain: { [OPERATION]: ops.posts.plain },
    optional: { [OPERATION]: ops.posts.optional },
    off: { [OPERATION]: ops.posts.off },
  },
};

describe('offlineSafe(p)', () => {
  it('puts a literal `true` into the meta type, so the compiler can see the policy', () => {
    expectTypeOf(orpc.posts.create['~op'].meta.offlineSafe).toEqualTypeOf<true>();
  });
});

describe('useOfflineMutation and queue.enqueue', () => {
  it('compile for a procedure the contract marked, typed by the contract input (client side of transforms)', () => {
    const { mutate } = useOfflineMutation(orpc.posts.create);
    expectTypeOf(mutate).parameter(0).toEqualTypeOf<{ title: string; at: string }>();
    void queue.enqueue(orpc.posts.create, { title: 'a', at: '2026-10-16' });
  });

  it('reject an input of the wrong shape', () => {
    // @ts-expect-error `at` is a string on the wire
    void queue.enqueue(orpc.posts.create, { title: 'a', at: new Date() });
  });

  it('reject the default meta', () => {
    // @ts-expect-error not marked offlineSafe
    useOfflineMutation(orpc.posts.plain);
    // @ts-expect-error not marked offlineSafe
    void queue.enqueue(orpc.posts.plain, { title: 'a', at: 'x' });
  });

  it('reject an optional `offlineSafe?: true` (a shared $meta cannot prove it)', () => {
    // @ts-expect-error optional is not proof
    useOfflineMutation(orpc.posts.optional);
  });

  it('reject `offlineSafe: false`', () => {
    // @ts-expect-error false is not true
    useOfflineMutation(orpc.posts.off);
  });

  it('reject a raw client leaf: it carries no operation', () => {
    // @ts-expect-error no '~op' on a raw oRPC client (or createTanstackQueryUtils) leaf
    useOfflineMutation(client.posts.create);
  });
});
