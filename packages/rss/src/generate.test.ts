import { describe, expect, it } from 'vitest';

import { generateAtom, generateFeed, generateRss } from './generate';
import type { Feed } from './index';
import { parseFeed } from './index';

const feed: Feed = {
  format: 'rss',
  title: 'Tom & "Jerry" <news>',
  description: "It's a feed",
  link: 'https://example.com',
  language: 'en-US',
  ttl: 60,
  updated: new Date('2026-09-03T00:00:00Z'),
  authors: [],
  links: [{ href: 'https://example.com/feed.xml', rel: 'self' }],
  extensions: {},
  namespaces: {},
  items: [
    {
      id: 'https://example.com/a',
      title: 'A < B & C',
      link: 'https://example.com/a?x=1&y=2',
      summary: 'Said "hi"',
      content: '<p>Body & soul</p>',
      published: new Date('2026-09-01T10:00:00Z'),
      authors: [{ name: 'Ada' }],
      categories: ['x&y'],
      links: [{ href: 'https://example.com/a.mp3', rel: 'enclosure', type: 'audio/mpeg', length: 5 }],
      extensions: { 'itunes:duration': [{ text: '01:02', attributes: {} }] },
    },
  ],
};

describe('generateRss', () => {
  it('escapes text and attributes', () => {
    const xml = generateRss(feed);
    expect(xml).toContain('<title>Tom &amp; "Jerry" &lt;news&gt;</title>');
    expect(xml).toContain('<link>https://example.com/a?x=1&amp;y=2</link>');
    expect(xml).toContain('<category>x&amp;y</category>');
    expect(xml).toContain('<content:encoded>&lt;p&gt;Body &amp; soul&lt;/p&gt;</content:encoded>');
    expect(xml).toContain('xmlns:itunes=');
  });

  it('drops control characters that XML forbids', () => {
    const xml = generateRss({ ...feed, title: 'a\u0001b' });
    expect(xml).toContain('<title>ab</title>');
  });

  it('round-trips through parseFeed', () => {
    const parsed = parseFeed(generateRss(feed));
    expect(parsed.title).toBe(feed.title);
    expect(parsed.description).toBe(feed.description);
    expect(parsed.ttl).toBe(60);
    expect(parsed.updated?.toISOString()).toBe('2026-09-03T00:00:00.000Z');
    expect(parsed.items[0]).toMatchObject({
      id: 'https://example.com/a',
      title: 'A < B & C',
      link: 'https://example.com/a?x=1&y=2',
      content: '<p>Body & soul</p>',
      authors: [{ name: 'Ada' }],
      categories: ['x&y'],
    });
    expect(parsed.items[0]?.links[0]).toMatchObject({ rel: 'enclosure', length: 5 });
  });

  it('writes the same bytes for the same input', () => {
    expect(generateRss(feed)).toBe(generateRss(feed));
  });

  it('can write compact output', () => {
    expect(generateRss(feed, { indent: false })).not.toContain('\n  <');
  });
});

describe('generateAtom', () => {
  it('round-trips through parseFeed', () => {
    const parsed = parseFeed(generateAtom(feed));
    expect(parsed.format).toBe('atom');
    expect(parsed.title).toBe(feed.title);
    expect(parsed.link).toBe('https://example.com');
    expect(parsed.items[0]).toMatchObject({
      id: 'https://example.com/a',
      title: 'A < B & C',
      link: 'https://example.com/a?x=1&y=2',
      summary: 'Said "hi"',
      content: '<p>Body & soul</p>',
      authors: [{ name: 'Ada' }],
      categories: ['x&y'],
    });
    expect(parsed.items[0]?.published?.toISOString()).toBe('2026-09-01T10:00:00.000Z');
  });

  it('falls back to the newest item date when the feed has none', () => {
    const xml = generateAtom({ ...feed, updated: undefined });
    expect(xml).toContain('<updated>2026-09-01T10:00:00.000Z</updated>');
  });
});

describe('generateFeed', () => {
  it('picks the writer by format', () => {
    expect(generateFeed(feed, 'rss')).toContain('<rss');
    expect(generateFeed(feed, 'atom')).toContain('<feed');
  });
});
