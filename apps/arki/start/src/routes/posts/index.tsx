import { createFileRoute } from '@tanstack/react-router';
import { Link } from '@tanstack/react-router';

import { PostsTimeline } from '@arki/content/components/PostsTimeline';
import { Shell } from '@arki/sitekit/components/shell';

import config from '~/config';
import { posts } from '~/content/util';
import { getDefaultMeta } from '~/shared-metadata';

export const Route = createFileRoute('/posts/')({
  validateSearch: (s: Record<string, unknown>) => ({ p: Number(s.p ?? 1) }),
  head: () =>
    getDefaultMeta({
      title: `Blog | ${config.appTitle}`,
      description: `Articles and updates from ${config.appTitle}`,
    }),
  component: PostsPage,
});

function PostsPage() {
  const searchParams = Route.useSearch();

  return (
    <Shell>
      <PostsTimeline
        appTitle={config.appTitle}
        posts={posts}
        searchParams={{ p: String(searchParams.p) }}
        Link={Link as Parameters<typeof PostsTimeline>[0]['Link']}
      />
    </Shell>
  );
}
