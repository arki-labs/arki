/**
 * Type proof (plan M0.4) against the installed oRPC 1.15.5 utils and TanStack
 * Query 5: `data` is the procedure's output, `select` narrows it, mutation
 * options and bare utils are rejected, a missing input fails. `tsc` checks
 * this file; the runtime test checks the key shape the provider will
 * invalidate by. Hooks are only type-checked here, never rendered.
 */
import type { ClientContext } from '@orpc/client';
import type { MaybeOptionalOptions } from '@orpc/shared';
import type { GeneralUtils, ProcedureUtils, QueryOptionsIn } from '@orpc/tanstack-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { oc } from '@orpc/contract';
import { createRouterClient, implement } from '@orpc/server';
import { createTanstackQueryUtils } from '@orpc/tanstack-query';
import { QueryClient, useQuery } from '@tanstack/react-query';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type { LiveMeta } from '../index.js';
import { live } from '../index.js';
import { useLiveQuery } from '../react.js';

const Post = z.object({ id: z.string(), title: z.string() });
type Post = z.infer<typeof Post>;
const contract = oc.$meta<LiveMeta>({});
const appContract = contract.router({
  posts: {
    list: contract
      .meta(live({ reads: [{ schema: 'public', table: 'posts' }] }))
      .input(z.object({ page: z.int().positive() }))
      .output(z.array(Post))
      .errors({ PAGE_OUT_OF_RANGE: { data: z.object({ last: z.int() }) } }),
    count: contract.meta(live({ reads: [{ schema: 'public', table: 'posts' }] })).output(z.int()),
    create: contract.input(z.object({ title: z.string() })).output(Post),
  },
});

let served = 0;
const impl = implement(appContract);
const router = impl.router({
  posts: {
    list: impl.posts.list.handler(({ input }) => {
      served += 1;
      return [{ id: `p${input.page}`, title: `page ${input.page}` }];
    }),
    count: impl.posts.count.handler(() => 1),
    create: impl.posts.create.handler(({ input }) => ({ id: 'p9', title: input.title })),
  },
});
const orpc = createTanstackQueryUtils(createRouterClient(router));

/** Never called: hooks need a component. `tsc` checks every line. */
function screens(): void {
  const list = useLiveQuery(orpc.posts.list.queryOptions({ input: { page: 1 } }));
  expectTypeOf(list.data).toEqualTypeOf<Post[] | undefined>();
  expectTypeOf(list.error).toExtend<Error | null>();

  const titles = useLiveQuery(
    orpc.posts.list.queryOptions({ input: { page: 1 }, select: rows => rows.map(row => row.title) }),
  );
  expectTypeOf(titles.data).toEqualTypeOf<string[] | undefined>();

  const count = useLiveQuery(orpc.posts.count.queryOptions());
  expectTypeOf(count.data).toEqualTypeOf<number | undefined>();

  // Same result type as TanStack's own hook.
  expectTypeOf(list).toEqualTypeOf(useQuery(orpc.posts.list.queryOptions({ input: { page: 1 } })));

  // @ts-expect-error -- mutation options are not query options
  useLiveQuery(orpc.posts.create.mutationOptions());
  // @ts-expect-error -- utils are not options: build them with `.queryOptions({ input })`
  useLiveQuery(orpc.posts.list);
  // @ts-expect-error -- `input` is required for `posts.list`
  useLiveQuery(orpc.posts.list.queryOptions());
  // @ts-expect-error -- the input is checked against the contract
  useLiveQuery(orpc.posts.list.queryOptions({ input: { page: 'one' } }));
}

/**
 * Counter-example (plan § 3 signature): with `C` and `I` generic, the body
 * cannot hand its options to `procedure.queryOptions` without a cast, because
 * oRPC's parameter `MaybeOptionalOptions<U & QueryOptionsIn<C, I, O, E, S>>`
 * stays a deferred conditional. If a future oRPC makes this compile, the
 * `@ts-expect-error` fails and the plan's form can come back.
 */
function planSignature<C extends ClientContext, I, O, E, S = O>(
  procedure: ProcedureUtils<C, I, O, E> & GeneralUtils<I>,
  input: I,
  ...options: MaybeOptionalOptions<Omit<QueryOptionsIn<C, I, O, E, S>, 'input' | 'queryKey' | 'queryFn'>>
): UseQueryResult<S, E> {
  const [rest] = options;
  // @ts-expect-error -- counter-example: not assignable to oRPC's deferred conditional parameter
  return useQuery(procedure.queryOptions({ ...rest, input }));
}

describe('the oRPC query key the provider invalidates by', () => {
  it('starts with the procedure path, and [path] matches every input of that procedure only', async () => {
    expect(typeof screens).toBe('function');
    expect(typeof planSignature).toBe('function');
    const queryClient = new QueryClient();
    const first = orpc.posts.list.queryOptions({ input: { page: 1 } });
    const second = orpc.posts.list.queryOptions({ input: { page: 2 } });
    const other = orpc.posts.count.queryOptions();
    expect(first.queryKey[0]).toEqual(['posts', 'list']);
    await queryClient.fetchQuery(first);
    await queryClient.fetchQuery(second);
    await queryClient.fetchQuery(other);
    expect(served).toBe(2);

    await queryClient.invalidateQueries({ queryKey: [['posts', 'list']] });
    expect(queryClient.getQueryState(first.queryKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(second.queryKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(other.queryKey)?.isInvalidated).toBe(false);
    queryClient.clear();
  });
});
