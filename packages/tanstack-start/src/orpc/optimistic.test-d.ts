import type { ContractRouterClient } from '@orpc/contract';
import { oc } from '@orpc/contract';
import { describe, expectTypeOf, it } from 'vitest';

import { page, z } from '@arki/contracts';

import { createOrpcUtils } from './client';
import { useKeysetQuery } from './keyset';
import { useOptimisticMutation } from './optimistic';

const post = z.object({ id: z.string(), title: z.string() });
type Post = z.output<typeof post>;
const contract = {
  posts: {
    list: oc.input(z.object({ cursor: z.string().optional(), status: z.string() })).output(page(post)),
    get: oc.input(z.object({ id: z.string() })).output(post),
    create: oc.input(post.omit({ id: true })).output(post),
  },
};

declare const client: ContractRouterClient<typeof contract>;
declare const strictClient: ContractRouterClient<typeof contract, { token: string }>;
const orpc = createOrpcUtils(contract, client);

describe('useOptimisticMutation', () => {
  it('types the input and the cache callbacks from the procedures, with no annotation', () => {
    const create = useOptimisticMutation(orpc.posts.create, {
      apply: (cache, input) => {
        expectTypeOf(input).toEqualTypeOf<{ title: string }>();
        cache.update(orpc.posts.get, { id: 'p1' }, current => {
          expectTypeOf(current).toEqualTypeOf<Post>();
          return { ...current, title: input.title };
        });
        cache.updateKeyset(orpc.posts.list, { status: 'published' }, items => {
          expectTypeOf(items).toEqualTypeOf<readonly Post[]>();
          return [{ id: 'tmp', ...input }, ...items];
        });
        cache.invalidate(orpc.posts);
      },
      onSuccess: output => expectTypeOf(output).toEqualTypeOf<Post>(),
    });
    expectTypeOf(create.mutate).parameter(0).toEqualTypeOf<{ title: string }>();
  });

  it('rejects cache.update with the wrong input', () => {
    useOptimisticMutation(orpc.posts.create, {
      // @ts-expect-error posts.get takes { id }, not { slug }
      apply: cache => cache.update(orpc.posts.get, { slug: 'x' }, current => current),
    });
  });

  it('rejects cache.update returning the wrong type', () => {
    useOptimisticMutation(orpc.posts.create, {
      // @ts-expect-error the edit must return a Post
      apply: cache => cache.update(orpc.posts.get, { id: 'p1' }, () => ({ id: 1 })),
    });
  });

  it('rejects cache.updateKeyset on a procedure that is not a keyset list', () => {
    useOptimisticMutation(orpc.posts.create, {
      // @ts-expect-error posts.get does not return a Page
      apply: cache => cache.updateKeyset(orpc.posts.get, { id: 'p1' }, items => [...items]),
    });
  });

  it('rejects a client that requires a context: the hooks send none', () => {
    const strict = createOrpcUtils(contract, strictClient);
    // @ts-expect-error the client context `{ token }` is required
    useOptimisticMutation(strict.posts.create, { apply: cache => cache.invalidate(strict.posts) });
    // @ts-expect-error same for the keyset hook
    useKeysetQuery(strict.posts.list, { status: 'x' });
  });
});
