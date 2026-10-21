import { describe, expect, it } from 'vitest';

import { FeedError, parseFeed } from './index';

const rss = `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Show &amp; Tell</title>
    <link>https://example.com</link>
    <description><![CDATA[A <b>bold</b> show]]></description>
    <language>en-US</language>
    <ttl>60</ttl>
    <itunes:image href="https://example.com/art.png"/>
    <atom:link href="https://example.com/feed.xml" rel="self" type="application/rss+xml"/>
    <item>
      <title>Episode &lt;1&gt;</title>
      <link>https://example.com/1</link>
      <guid isPermaLink="false">ep-1</guid>
      <pubDate>Tue, 01 Sep 2026 10:00:00 GMT</pubDate>
      <dc:creator>Ada</dc:creator>
      <content:encoded><![CDATA[<p>Hello</p>]]></content:encoded>
      <category>news</category>
      <enclosure url="https://example.com/1.mp3" length="1234" type="audio/mpeg"/>
      <itunes:duration>01:02</itunes:duration>
    </item>
  </channel>
</rss>`;

const atom = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en">
  <id>urn:feed:1</id>
  <title type="html">Atom &amp; Co</title>
  <subtitle>Sub</subtitle>
  <updated>2026-09-02T00:00:00Z</updated>
  <link href="https://example.com/" rel="alternate"/>
  <link href="https://example.com/atom.xml" rel="self"/>
  <author><name>Bo</name><email>bo@example.com</email></author>
  <entry>
    <id>urn:entry:1</id>
    <title>First</title>
    <link href="https://example.com/a"/>
    <link href="https://example.com/a.mp3" rel="enclosure" type="audio/mpeg" length="9"/>
    <updated>2026-09-02T00:00:00Z</updated>
    <published>2026-09-01T00:00:00Z</published>
    <summary>Short</summary>
    <content type="html">&lt;p&gt;Body&lt;/p&gt;</content>
    <category term="tech"/>
    <author><name>Cy</name></author>
  </entry>
</feed>`;

describe('parseFeed', () => {
  it('reads RSS 2.0 channel and items', () => {
    const feed = parseFeed(rss);
    expect(feed.format).toBe('rss');
    expect(feed.title).toBe('Show & Tell');
    expect(feed.description).toBe('A <b>bold</b> show');
    expect(feed.link).toBe('https://example.com');
    expect(feed.ttl).toBe(60);
    expect(feed.links).toContainEqual({ href: 'https://example.com/feed.xml', rel: 'self', type: 'application/rss+xml' });
    expect(feed.items).toHaveLength(1);
    const [item] = feed.items;
    expect(item?.title).toBe('Episode <1>');
    expect(item?.id).toBe('ep-1');
    expect(item?.published?.toISOString()).toBe('2026-09-01T10:00:00.000Z');
    expect(item?.categories).toEqual(['news']);
    expect(item?.links).toEqual([
      { href: 'https://example.com/1.mp3', rel: 'enclosure', type: 'audio/mpeg', length: 1234 },
    ]);
  });

  it('keeps namespaced elements: content:encoded, dc:creator and extensions', () => {
    const feed = parseFeed(rss);
    const [item] = feed.items;
    expect(item?.content).toBe('<p>Hello</p>');
    expect(item?.authors).toEqual([{ name: 'Ada' }]);
    expect(item?.extensions['itunes:duration']).toEqual([{ text: '01:02', attributes: {} }]);
    expect(feed.extensions['itunes:image']?.[0]?.attributes).toEqual({ href: 'https://example.com/art.png' });
    expect(feed.namespaces.itunes).toBe('http://www.itunes.com/dtds/podcast-1.0.dtd');
  });

  it('reads Atom feeds, entries, authors and enclosures', () => {
    const feed = parseFeed(atom);
    expect(feed.format).toBe('atom');
    expect(feed.id).toBe('urn:feed:1');
    expect(feed.title).toBe('Atom & Co');
    expect(feed.description).toBe('Sub');
    expect(feed.link).toBe('https://example.com/');
    expect(feed.language).toBe('en');
    expect(feed.authors).toEqual([{ name: 'Bo', email: 'bo@example.com' }]);
    const [entry] = feed.items;
    expect(entry?.link).toBe('https://example.com/a');
    expect(entry?.links).toEqual([
      { href: 'https://example.com/a.mp3', rel: 'enclosure', type: 'audio/mpeg', length: 9 },
    ]);
    expect(entry?.content).toBe('<p>Body</p>');
    expect(entry?.categories).toEqual(['tech']);
    expect(entry?.authors).toEqual([{ name: 'Cy' }]);
    expect(entry?.published?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('decodes escaped characters once and keeps identifiers as strings', () => {
    const feed = parseFeed(
      '<rss version="2.0"><channel><title>a &amp;amp; b &#38; c</title><item><title>007</title><guid>0001</guid></item></channel></rss>',
    );
    expect(feed.title).toBe('a &amp; b & c');
    expect(feed.items[0]?.title).toBe('007');
    expect(feed.items[0]?.id).toBe('0001');
  });

  it('rejects malformed XML with a coded error', () => {
    const xml = '<rss version="2.0"><channel><title>x</channel></rss>';
    expect(() => parseFeed(xml)).toThrow(FeedError);
    expect(() => parseFeed(xml)).toThrow(expect.objectContaining({ code: 'FEED_MALFORMED' }));
  });

  it('rejects documents that are not feeds', () => {
    expect(() => parseFeed('<html><body/></html>')).toThrow(expect.objectContaining({ code: 'FEED_MALFORMED' }));
  });

  it('rejects entity declarations', () => {
    const bomb = '<!DOCTYPE rss [<!ENTITY a "aaaa">]><rss version="2.0"><channel><title>&a;</title></channel></rss>';
    expect(() => parseFeed(bomb)).toThrow(expect.objectContaining({ code: 'FEED_UNSUPPORTED' }));
  });

  it('rejects input over the byte limit, counting UTF-8 bytes', () => {
    const body = `<rss version="2.0"><channel><title>${'é'.repeat(100)}</title></channel></rss>`;
    expect(parseFeed(body, { maxBytes: 1000 }).title).toHaveLength(100);
    expect(() => parseFeed(body, { maxBytes: 150 })).toThrow(expect.objectContaining({ code: 'FEED_TOO_LARGE' }));
  });

  it('rejects feeds with too many items', () => {
    const items = '<item><title>x</title></item>'.repeat(3);
    const xml = `<rss version="2.0"><channel><title>t</title>${items}</channel></rss>`;
    expect(parseFeed(xml, { maxItems: 3 }).items).toHaveLength(3);
    expect(() => parseFeed(xml, { maxItems: 2 })).toThrow(expect.objectContaining({ code: 'FEED_LIMIT_EXCEEDED' }));
  });
});
