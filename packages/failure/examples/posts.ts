// #region define
import { z } from 'zod';

import { defineFailure, isFailure, match, recover } from '@arki/failure';

export const PostNotFound = defineFailure('post.not_found', {
  status: 404,
  data: z.object({ id: z.string() }),
  message: 'no post {id}',
});

type Post = { id: string; title: string };
const posts = new Map<string, Post>([['p1', { id: 'p1', title: 'Hello' }]]);

export const find = async (id: string) => posts.get(id) ?? PostNotFound({ id });
// #endregion define

// #region early-return
export async function titleOf(id: string) {
  const post = await find(id);
  if (isFailure(post)) return post; // the failure joins this function's inferred result
  return post.title; // narrowed to Post
}
// #endregion early-return

// #region match
export async function label(id: string) {
  return match(await find(id), {
    ok: post => post.title,
    'post.not_found': failure => `missing ${failure.data.id}`,
  });
}
// #endregion match

// #region recover
export async function titleOrDraft(id: string) {
  return recover(await find(id), { 'post.not_found': () => 'Untitled draft' });
}
// #endregion recover
