import type { ORPCError } from '@orpc/contract';
import { oc } from '@orpc/contract';
import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod/v4';

import type { ErrorOf, Identified, InputOf, MetaOf, Operation, OperationOf, Operations, OutputOf } from './orpc.js';
import { operationOf, operations } from './orpc.js';

const postId = z.string().brand<'PostId'>();
const getPost = oc
  .$meta<{ cache: 'short' }>({ cache: 'short' })
  .errors({ NOT_FOUND: { data: z.object({ id: z.string() }) } })
  .input(z.object({ id: z.string(), at: z.string().transform(text => new Date(text)) }))
  .output(z.object({ id: postId, title: z.string() }));

const contract = { posts: { get: getPost, health: { ping: oc.output(z.literal('pong')) } } };

describe('OperationOf', () => {
  type Op = OperationOf<typeof getPost>;

  it('infers the input the CLIENT sends (before transforms) and the output it gets (after them)', () => {
    expectTypeOf<InputOf<Op>>().toEqualTypeOf<{ id: string; at: string }>();
    expectTypeOf<OutputOf<Op>>().toEqualTypeOf<{ id: string & z.core.$brand<'PostId'>; title: string }>();
  });

  it('infers the typed errors and the meta', () => {
    expectTypeOf<ORPCError<'NOT_FOUND', { id: string }>>().toExtend<ErrorOf<Op>>();
    expectTypeOf<MetaOf<Op>['cache']>().toEqualTypeOf<'short'>();
  });
});

describe('operations', () => {
  it('keeps the contract keys and puts an Operation at every leaf, with no annotation', () => {
    const ops = operations(contract);
    expectTypeOf(ops.posts.get).toEqualTypeOf<OperationOf<typeof getPost>>();
    expectTypeOf(ops.posts.health.ping.meta).toEqualTypeOf<Record<never, never>>();
    expectTypeOf(ops).toEqualTypeOf<Operations<typeof contract>>();
  });

  it('does not accept something that is not a contract', () => {
    // @ts-expect-error a number is not a contract router
    operations(42);
  });
});

describe('operationOf', () => {
  it('returns the exact operation type the carrier holds', () => {
    const carrier: Identified<OperationOf<typeof getPost>> = { '~op': operations(contract).posts.get };
    expectTypeOf(operationOf(carrier)).toEqualTypeOf<OperationOf<typeof getPost>>();
  });

  it('rejects a value with no operation at compile time too', () => {
    // @ts-expect-error a plain object is not Identified
    operationOf({ call: 'not an operation' });
  });

  it('an Operation is assignable to the loose shape, so generic code can take any of them', () => {
    expectTypeOf<OperationOf<typeof getPost>>().toExtend<Operation<unknown, unknown, unknown, Record<string, unknown>>>();
  });
});
