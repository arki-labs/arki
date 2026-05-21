import { createFileRoute } from '@tanstack/react-router';

import { buildPostFeed } from '@arki/content/collections/feeds/post';

import config from '~/config';
import { posts } from '~/content/util';

export const Route = createFileRoute('/posts/feed.xml')({
  server: {
    handlers: {
      GET: () => {
        const feed = buildPostFeed(posts, {
          appTitle: config.appTitle,
          appDomain: config.appDomain,
          appLink: config.appLink,
        });
        return new Response(feed, {
          headers: { 'Content-Type': 'application/xml; charset=utf-8' },
        });
      },
    },
  },
});
