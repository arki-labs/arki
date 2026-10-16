import type { FormEvent } from 'react';
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';

import { LiveProvider, useLiveQuery, useLiveStatus } from '@arki/live/react';

import { orpc } from '../orpc';

export const Route = createFileRoute('/')({ component: Home });

function Home() {
  return (
    <LiveProvider url="/api/live">
      <main>
        <LiveStatusBadge />
        <PostList />
        <NewPostForm />
      </main>
    </LiveProvider>
  );
}

/** `connecting` on the server; `live` only once the provider's effect ran, so it doubles as the hydration marker. */
function LiveStatusBadge() {
  return <p data-testid="live-status">{useLiveStatus()}</p>;
}

function PostList() {
  const posts = useLiveQuery(orpc.posts.list.queryOptions());
  if (posts.isPending) return <p>Loading</p>;
  return (
    <>
      {posts.isError ? <p role="alert">{posts.error.message}</p> : null}
      <ul data-testid="posts">
        {posts.data?.map(post => (
          <li key={post.id}>{post.title}</li>
        ))}
      </ul>
    </>
  );
}

/** No `onSuccess` invalidation: this tab, like every other, sees its post only through the live stream. */
function NewPostForm() {
  const [title, setTitle] = useState('');
  const create = useMutation(orpc.posts.create.mutationOptions({ onSuccess: () => setTitle('') }));
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    create.mutate({ title });
  };
  return (
    <form onSubmit={submit}>
      <input aria-label="Title" value={title} onChange={event => setTitle(event.target.value)} />
      <button type="submit" disabled={create.isPending}>
        Post
      </button>
    </form>
  );
}
