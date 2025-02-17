import { RSS } from '@arki/rss';

import type { Changelog } from '../changelog';

export function buildChangelogFeed(
  items: Changelog[],
  {
    appTitle,
    appDomain,
    appLink,
  }: {
    appTitle: string;
    appDomain: string;
    appLink: string;
  },
) {
  const feed = new RSS({
    title: appTitle,
    description: appTitle + ' changelog feed',
    generator: appTitle,
    feed_url: appLink + '/changelog/feed.xml',
    site_url: appLink,
    managingEditor: `ping@${appDomain} (${appTitle} Team)`,
    webMaster: `ping@${appDomain} (${appTitle} Team)`,
    copyright: `Copyright ${new Date().getFullYear().toString()}, ${appTitle}`,
    language: 'en-US',
    pubDate: new Date().toUTCString(),
    ttl: 60,
  });

  items.map(post => {
    feed.item({
      title: post.title,
      description: post.description,
      url: `${appLink}/changelog/${post.slug}`,
      author: appTitle + ' Team',
      date: post.publishedAt,
    });
  });
  return feed.xml({ indent: true });
}
