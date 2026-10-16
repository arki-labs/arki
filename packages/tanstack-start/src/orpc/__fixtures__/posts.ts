/**
 * Test fixture: a small posts contract served in-process by oRPC itself, so
 * the hooks run against a real client (real keys, real validation) with no
 * network. Each test swaps `backend.*` to control answers and timing.
 */
import { oc } from '@orpc/contract';
import { createRouterClient, implement } from '@orpc/server';
import { vi } from 'vitest';

import { page, z } from '@arki/contracts';

import { createOrpcUtils } from '../client';

const post = z.object({ id: z.string(), title: z.string() });
const listInput = z.object({
  cursor: z.string().optional(),
  limit: z.int().min(1).max(100).default(2),
  status: z.string(),
});
const reaction = z.object({ type: z.string() }).nullable();

export type Post = z.output<typeof post>;
export type ListInput = z.output<typeof listInput>;
export type PostPage = z.output<ReturnType<typeof page<typeof post>>>;
export type Reaction = z.output<typeof reaction>;

export const postsContract = {
  posts: {
    list: oc.input(listInput).output(page(post)),
    get: oc.input(z.object({ id: z.string() })).output(post),
    reaction: oc.input(z.object({ id: z.string() })).output(reaction),
    create: oc.input(post.omit({ id: true })).output(post),
    react: oc.input(z.object({ id: z.string(), type: z.string().optional() })).output(reaction),
  },
  health: { ping: oc.output(z.literal('pong')) },
};

/** What the fake server answers. Tests replace these. */
export function createBackend() {
  return {
    list: vi.fn(
      async (input: ListInput): Promise<PostPage> => ({
        items: [{ id: `${input.status}-${input.cursor ?? 'first'}`, title: 'A' }],
        nextCursor: null,
      }),
    ),
    get: vi.fn(async (input: { id: string }): Promise<Post> => ({ id: input.id, title: 'From server' })),
    reaction: vi.fn(async (_input: { id: string }): Promise<Reaction> => null),
    create: vi.fn(async (input: Omit<Post, 'id'>): Promise<Post> => ({ id: 'srv_1', ...input })),
    react: vi.fn(async (input: { id: string; type?: string | undefined }): Promise<Reaction> =>
      input.type === undefined ? null : { type: input.type },
    ),
  };
}

export type Backend = ReturnType<typeof createBackend>;

/** A real in-process oRPC client and the contract-built utils over it. */
export function servePosts(backend: Backend) {
  const impl = implement(postsContract);
  const router = impl.router({
    posts: {
      list: impl.posts.list.handler(({ input }) => backend.list(input)),
      get: impl.posts.get.handler(({ input }) => backend.get(input)),
      reaction: impl.posts.reaction.handler(({ input }) => backend.reaction(input)),
      create: impl.posts.create.handler(({ input }) => backend.create(input)),
      react: impl.posts.react.handler(({ input }) => backend.react(input)),
    },
    health: { ping: impl.health.ping.handler(() => 'pong' as const) },
  });
  const client = createRouterClient(router);
  return { client, orpc: createOrpcUtils(postsContract, client) };
}

/** A promise the test resolves or rejects by hand. */
export function deferred<T>() {
  return Promise.withResolvers<T>();
}
