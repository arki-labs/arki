import { describe, expect, it } from 'vitest';

import { parseFeed } from '@arki/rss';

import type { Changelog, Post } from './index';
import { buildChangelogFeed, buildPostFeed } from './index';

const site = {
  appTitle: 'Acme & Co',
  appDomain: 'acme.test',
  appLink: 'https://acme.test',
  now: new Date('2026-10-14T12:00:00Z'),
};

function post(slug: string, title: string, publishedAt: string, author = 'Ada'): Post {
  return {
    title,
    description: `About ${title}`,
    publishedAt: new Date(publishedAt),
    author: { name: author },
    tags: [],
    content: { mdx: '', raw: '' },
    readingTime: '1 min read',
    lastModification: publishedAt,
    image: { url: '', blurDataURL: '' },
    url: `/posts/${slug}`,
    slug,
    _meta: { directory: slug, fileName: 'index.mdx', filePath: `${slug}/index.mdx`, extension: 'mdx', path: slug },
  };
}

function entry(slug: string, title: string, publishedAt: string): Changelog {
  return {
    title,
    description: `Changes in ${title}`,
    publishedAt: new Date(publishedAt),
    content: { mdx: '', raw: '' },
    image: { url: '', blurDataURL: '' },
    url: `/changelog/${slug}`,
    slug,
    _meta: { directory: slug, fileName: 'index.mdx', filePath: `${slug}/index.mdx`, extension: 'mdx', path: slug },
  };
}

describe('buildPostFeed', () => {
  const posts = [
    post('b', 'Second <post>', '2026-02-01T00:00:00Z', 'Bo & Cy'),
    post('a', 'First', '2026-01-01T00:00:00Z'),
  ];

  it('keeps the order it is given', () => {
    const feed = parseFeed(buildPostFeed(posts, site));
    expect(feed.items.map(item => item.link)).toEqual(['https://acme.test/posts/b', 'https://acme.test/posts/a']);
  });

  it('escapes titles, authors and the site title in the XML', () => {
    const xml = buildPostFeed(posts, site);
    expect(xml).toContain('<title>Acme &amp; Co</title>');
    expect(xml).toContain('<title>Second &lt;post&gt;</title>');
    expect(xml).toContain('<dc:creator>Bo &amp; Cy</dc:creator>');
    const feed = parseFeed(xml);
    expect(feed.title).toBe('Acme & Co');
    expect(feed.items[0]?.title).toBe('Second <post>');
    expect(feed.items[0]?.authors).toEqual([{ name: 'Bo & Cy' }]);
  });

  it('uses the injected time, so the same input gives the same bytes', () => {
    expect(buildPostFeed(posts, site)).toBe(buildPostFeed(posts, site));
    const feed = parseFeed(buildPostFeed(posts, site));
    expect(feed.updated?.toISOString()).toBe('2026-10-14T12:00:00.000Z');
    expect(feed.copyright).toBe('Copyright 2026, Acme & Co');
  });

  it('points readers at the feed itself and at each post', () => {
    const feed = parseFeed(buildPostFeed(posts, site));
    expect(feed.links).toContainEqual(
      expect.objectContaining({ href: 'https://acme.test/posts/feed.xml', rel: 'self' }),
    );
    expect(feed.items[1]?.id).toBe('https://acme.test/posts/a');
    expect(feed.items[1]?.published?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('buildChangelogFeed', () => {
  it('credits the team and keeps the order it is given', () => {
    const feed = parseFeed(
      buildChangelogFeed([entry('v2', 'v2', '2026-03-01T00:00:00Z'), entry('v1', 'v1', '2026-02-01T00:00:00Z')], site),
    );
    expect(feed.items.map(item => item.title)).toEqual(['v2', 'v1']);
    expect(feed.items[0]?.authors).toEqual([{ name: 'Acme & Co Team' }]);
    expect(feed.items[0]?.link).toBe('https://acme.test/changelog/v2');
    expect(feed.description).toBe('Acme & Co changelog feed');
  });
});
