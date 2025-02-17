import { RSS } from '@arki/rss';

import type { Post } from '../post';

export function buildPostFeed(
  items: Post[],
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
    description: appTitle + ' blog feed',
    generator: appDomain,
    feed_url: appLink + '/posts/feed.xml',
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
      url: `${appLink}/posts/${post.slug}`,
      author: post.author.name,
      date: post.publishedAt,
    });
  });

  return feed.xml({ indent: true });
}
