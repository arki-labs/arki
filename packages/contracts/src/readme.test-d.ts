// The README's `@arki/contracts/orpc` example, compiled.
import { oc } from '@orpc/contract';
import { expectTypeOf, it } from 'vitest';
import { z } from 'zod/v4';

import { operations } from './orpc.js';

const post = z.object({ id: z.string(), title: z.string() });
const createPost = post.omit({ id: true });

it('README: operations()', () => {
  const contract = { posts: { create: oc.input(createPost).output(post) } };
  const ops = operations(contract);
  expectTypeOf(ops.posts.create.name).toEqualTypeOf<string>();
  expectTypeOf(ops.posts.create.path).toEqualTypeOf<readonly string[]>();
  expectTypeOf(ops.posts.create.meta).toEqualTypeOf<Record<never, never>>();
});
