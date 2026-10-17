// The app pieces the README examples use but do not define: a post repository,
// a few failures, and small stand-ins for an export step, a feed and an RPC client.
import { ORPCError } from '@orpc/client';
import { z } from 'zod';

import { defineFailure } from '@arki/failure';

import type { find } from '../../examples/posts.ts';
import { PostNotFound } from '../../examples/posts.ts';

export { find, PostNotFound } from '../../examples/posts.ts';

export const PostId = z.string();
export type PostId = z.infer<typeof PostId>;

export const PostSchema = z.object({ id: PostId, title: z.string() });
export type Post = z.infer<typeof PostSchema>;

const stored = new Map<PostId, Post>([['p1', { id: 'p1', title: 'Hello' }]]);

/** An in-memory post repository. */
export const repo = {
  delete: async (id: PostId) => {
    await Promise.resolve();
    return stored.delete(id);
  },
};

export const id: PostId = 'p1';
export const ids: PostId[] = ['p1', 'p2'];
export const a: PostId = 'p1';
export const b = 'ada';

export const EmailTaken = defineFailure('user.email_taken', {
  status: 409,
  data: z.object({ email: z.string() }),
  message: 'email {email} is taken',
});
export const InvalidJson = defineFailure('json.invalid', {
  status: 400,
  data: z.object({ reason: z.string() }),
});
export const DbTimeout = defineFailure('db.timeout', { status: 503 });
export const SyncFailed = defineFailure('sync.failed', {
  status: 502,
  data: z.object({ feed: z.string() }),
});
export const OutOfStock = defineFailure('shop.out_of_stock', { status: 409 });
export const Busy = defineFailure('shop.busy', { status: 503 });

/** The text `JSON.parse` reads in the `attempt` example. */
export const text = '{"ok":true}';
export const url = 'https://example.com/page';
export const fetchPage = async (_url: string) => {
  await Promise.resolve();
  return 'page body';
};

/** A message that crossed a queue: a failure turned into JSON text. */
export const message = JSON.stringify(EmailTaken({ email: 'ada@example.com' }));

/** A sync failure whose cause is a database timeout. */
export const syncFailure = SyncFailed({ feed: 'hn' }, { cause: DbTimeout() });

export class ConnectionError extends Error {}
/** An error whose cause chain holds a `ConnectionError`. */
export const error = new Error('request failed', { cause: new ConnectionError('socket hang up') });

export const findAuthor = async (name: string) => {
  await Promise.resolve();
  return name === 'ada' ? { name } : PostNotFound({ id: name });
};

export const NotionTokenRejected = defineFailure('export.notion_token_rejected', { status: 422 });

export type Item = { id: string };
export const items: Item[] = [{ id: 'a' }, { id: 'b' }, { id: 'bad' }, { id: 'c' }];
/** Delivers an item, or fails once the token is refused (on the item `bad`). */
export const send = async (item: Item) => {
  await Promise.resolve();
  return item.id === 'bad' ? NotionTokenRejected() : item;
};
export const save = (_delivered: Item[]): void => {
  // the app would persist them here
};

/** Deletes a post, or fails when it is not there. */
export async function remove(postId: PostId) {
  if (!(await repo.delete(postId))) return PostNotFound({ id: postId });
  return;
}

type Refusal = ReturnType<typeof OutOfStock> | ReturnType<typeof Busy>;
/** Lets one checked refusal through (the `@arki/journal` command context has one). */
export const accept = (_value: unknown): void => {
  // the app would record the refusal here
};
export const r: Refusal | string = 'fine';

/** A stand-in RPC client: `byId` answers like the oRPC procedure in the example above. */
export const client = {
  posts: {
    byId: async (input: { id: PostId }) => {
      await Promise.resolve();
      const post = stored.get(input.id);
      if (post) return post;
      throw new ORPCError('post.not_found', { status: 404, defined: true, data: { id: input.id } });
    },
  },
};

export type AppContext = { usecases: { find: (id: PostId) => ReturnType<typeof find> } };
