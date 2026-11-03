import type { Feed, FeedItem } from './rss/index.js';
import { generateRss } from './rss/generate.js';

export type FeedSiteOptions = {
  appTitle: string;
  appDomain: string;
  appLink: string;
  /** The build time stamped on the feed. Defaults to the moment of the call. */
  now?: Date;
};

/** What a post feed reads from each post. A content-build `Post` has these fields. */
export type FeedPost = {
  title: string;
  description: string;
  slug: string;
  publishedAt: Date;
  author: { name: string };
};

/** What a changelog feed reads from each entry. A content-build `Changelog` has these fields. */
export type FeedChangelogEntry = Omit<FeedPost, 'author'>;

type FeedSection = {
  path: 'posts' | 'changelog';
  description: string;
  generator: string;
};

type FeedEntry = FeedChangelogEntry & { author: string };

function itemFor(entry: FeedEntry, url: string): FeedItem {
  return {
    id: url,
    title: entry.title,
    link: url,
    summary: entry.description,
    published: entry.publishedAt,
    authors: [{ name: entry.author }],
    categories: [],
    links: [],
    extensions: {},
  };
}

function buildFeed(
  entries: readonly FeedEntry[],
  { appTitle, appDomain, appLink, now = new Date() }: FeedSiteOptions,
  section: FeedSection,
): string {
  const feed: Feed = {
    format: 'rss',
    title: appTitle,
    description: section.description,
    link: appLink,
    generator: section.generator,
    language: 'en-US',
    copyright: `Copyright ${now.getFullYear().toString()}, ${appTitle}`,
    managingEditor: `ping@${appDomain} (${appTitle} Team)`,
    webMaster: `ping@${appDomain} (${appTitle} Team)`,
    ttl: 60,
    updated: now,
    authors: [],
    links: [{ href: `${appLink}/${section.path}/feed.xml`, rel: 'self' }],
    extensions: {},
    namespaces: {},
    items: entries.map(entry => itemFor(entry, `${appLink}/${section.path}/${entry.slug}`)),
  };
  return generateRss(feed);
}

/** RSS 2.0 feed of blog posts, in the order given. */
export function buildPostFeed(items: readonly FeedPost[], options: FeedSiteOptions): string {
  return buildFeed(
    items.map(post => ({ ...post, author: post.author.name })),
    options,
    { path: 'posts', description: `${options.appTitle} blog feed`, generator: options.appDomain },
  );
}

/** RSS 2.0 feed of changelog entries, in the order given. */
export function buildChangelogFeed(items: readonly FeedChangelogEntry[], options: FeedSiteOptions): string {
  return buildFeed(
    items.map(entry => ({ ...entry, author: `${options.appTitle} Team` })),
    options,
    { path: 'changelog', description: `${options.appTitle} changelog feed`, generator: options.appTitle },
  );
}
