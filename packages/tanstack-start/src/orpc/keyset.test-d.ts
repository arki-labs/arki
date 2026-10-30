import type { ContractRouterClient } from '@orpc/contract';
import { oc } from '@orpc/contract';
import { createTanstackQueryUtils } from '@orpc/tanstack-query';
import { describe, expectTypeOf, it } from 'vitest';

import { page, z } from '@arki/contracts';

import { createOrpcUtils } from './client';
import { keysetKey, keysetOptions, useKeysetQuery } from './keyset';

const post = z.object({ id: z.string().brand<'PostId'>(), title: z.string() });
type Post = z.output<typeof post>;
const listInput = z.object({ cursor: z.string().optional(), limit: z.int().default(20), status: z.string() });

const contract = {
  posts: {
    list: oc.input(listInput).output(page(post)),
    all: oc.input(listInput).output(z.array(post)),
    withTotals: oc.input(listInput).output(page(post).extend({ hasMore: z.boolean(), total: z.number() })),
    byIds: oc.input(z.object({ ids: z.array(z.string()) })).output(page(post)),
  },
};

declare const client: ContractRouterClient<typeof contract>;
declare const contextClient: ContractRouterClient<typeof contract, { idempotencyKey?: string }>;
const orpc = createOrpcUtils(contract, client);

describe('useKeysetQuery', () => {
  it('infers the item type: items is Post[] with no annotation', () => {
    const { items, error } = useKeysetQuery(orpc.posts.list, { status: 'published' });
    expectTypeOf(items).toEqualTypeOf<readonly Post[]>();
    expectTypeOf(error).toExtend<Error | null>();
  });

  it('takes router-built utils too (createTanstackQueryUtils), not only contract-built ones', () => {
    const plain = createTanstackQueryUtils(client);
    expectTypeOf(useKeysetQuery(plain.posts.list, { status: 'x' }).items).toEqualTypeOf<readonly Post[]>();
  });

  it('takes a client whose context is optional (the oRPC default, and a common app shape)', () => {
    const withContext = createOrpcUtils(contract, contextClient);
    expectTypeOf(useKeysetQuery(withContext.posts.list, { status: 'x' }).items).toEqualTypeOf<readonly Post[]>();
  });

  it('takes a page with extra fields (hasMore, totals): the page part is what it reads', () => {
    const { items, query } = useKeysetQuery(orpc.posts.withTotals, { status: 'x' });
    expectTypeOf(items).toEqualTypeOf<readonly Post[]>();
    expectTypeOf(query.data?.pages[0]?.total).toEqualTypeOf<number | undefined>();
  });

  it('rejects a procedure whose output is not a Page', () => {
    // @ts-expect-error output is Post[], not Page<Post>
    useKeysetQuery(orpc.posts.all, { status: 'x' });
  });

  it('rejects a procedure whose input has no cursor', () => {
    // @ts-expect-error the input has no cursor/limit: not a keyset list
    useKeysetQuery(orpc.posts.byIds, { ids: [] });
  });

  it('rejects args of the wrong shape', () => {
    // @ts-expect-error status must be a string
    useKeysetQuery(orpc.posts.list, { status: 1 });
  });

  it('keysetKey and keysetOptions are typed by the same procedure', () => {
    const key = keysetKey(orpc.posts.list, { status: 'x' });
    expectTypeOf(keysetOptions(orpc.posts.list, { status: 'x' }).queryKey).toEqualTypeOf(key);
  });
});
