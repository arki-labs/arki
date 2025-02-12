import { defineCollection } from '@content-collections/core';
import { compileMDX } from '@content-collections/mdx';
import readingTime from 'reading-time';

import { RSS } from '@arki/rss';

import { addIdToHeadings } from '../plugins/add-id-to-headings';

export type Changelog = {
  title: string;
  description: string;
  image: string;
  publishedAt: Date;
  mdx: string;
  slug: string;
  readingTime: string;
};

export const changelogs = defineCollection({
  name: 'Changelogs',
  directory: 'src/content/changelog',
  include: '*/index.mdx',
  schema: z => ({
    title: z.string(),
    description: z.string(),
    image: z.string(),
    publishedAt: z.coerce.date(),
  }),
  transform: async (document, context) => {
    const mdx = await compileMDX(context, document, {
      rehypePlugins: [addIdToHeadings],
    });
    return {
      ...document,
      mdx,
      slug: document._meta.fileName.replace(/\.mdx$/, ''),
      readingTime: readingTime(document.content).text,
    };
  },
});

export type ChangelogCollectionType = typeof changelogs;

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
