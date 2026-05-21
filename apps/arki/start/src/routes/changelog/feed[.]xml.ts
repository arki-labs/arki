import { createFileRoute } from '@tanstack/react-router';

import { buildChangelogFeed } from '@arki/content/collections/feeds/changelog';

import config from '~/config';
import { changelogs } from '~/content/util';

export const Route = createFileRoute('/changelog/feed.xml')({
  server: {
    handlers: {
      GET: () => {
        const feed = buildChangelogFeed(changelogs, {
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
