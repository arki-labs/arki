// The README's oRPC examples, compiled.
import { oc } from '@orpc/contract';
import type { ContractRouterClient } from '@orpc/contract';
import { QueryClient } from '@tanstack/react-query';
import { expectTypeOf, it } from 'vitest';

import { keyset, page, pageInput, z } from '@arki/contracts';

import { createORPCClient, createORPCReact, createOrpcUtils, RPCLink } from './client';
import { keysetOptions, useKeysetQuery, useOptimisticMutation } from './query';

const post = z.object({ id: z.string(), title: z.string() });
const postOrder = keyset({ createdAt: 'desc', id: 'desc' });
const rpcContract = {
  posts: {
    list: oc.input(pageInput(postOrder).extend({ status: z.string() })).output(page(post)),
    create: oc.input(post.omit({ id: true })).output(post),
  },
};
const tempId = () => 'tmp';

it('README: client setup', () => {
  const link = new RPCLink({ url: '/api/orpc' });
  const client: ContractRouterClient<typeof rpcContract> = createORPCClient(link);
  const orpc = createOrpcUtils(rpcContract, client);
  expectTypeOf(orpc.posts.create['~op'].name).toEqualTypeOf<string>();
  expectTypeOf(createORPCReact(rpcContract, { url: '/api/orpc' }).orpc.posts.list['~op'].path).toEqualTypeOf<
    readonly string[]
  >();
});

it('README: hooks and the loader recipe', async () => {
  const { orpc } = createORPCReact(rpcContract);
  const { items, status, loadMore } = useKeysetQuery(orpc.posts.list, { status: 'published' });
  expectTypeOf(items).toEqualTypeOf<readonly { id: string; title: string }[]>();
  if (status === 'canLoadMore') await loadMore(50);

  useOptimisticMutation(orpc.posts.create, {
    apply: (cache, input) =>
      cache.updateKeyset(orpc.posts.list, { status: 'published' }, (list, pageIndex) =>
        pageIndex === 0 ? [{ ...input, id: tempId() }, ...list] : [...list],
      ),
  });

  const queryClient = new QueryClient();
  await queryClient.infiniteQuery({ ...keysetOptions(orpc.posts.list, { status: 'published' }), staleTime: 'static' });
});
