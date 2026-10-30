import { describe, expect, it } from 'vitest';

import { renderSitemapIndex, renderUrlset } from './sitemap';

describe('sitemap with an Invalid Date', () => {
  // Why: toISOString() throws on an Invalid Date; one bad entry must not fail the whole sitemap.
  const bad = new Date('not a date');
  const good = new Date('2026-01-02T03:04:05Z');

  it('lists the bad entry without lastmod and keeps the rest', () => {
    const xml = renderUrlset([
      { url: 'https://example.com/a', lastModified: bad },
      { url: 'https://example.com/b', lastModified: good },
    ]);
    expect(xml).toContain('<loc>https://example.com/a</loc>');
    expect(xml).toContain('<lastmod>2026-01-02T03:04:05.000Z</lastmod>');
    expect(xml.match(/<lastmod>/g)).toHaveLength(1);
  });

  it('does the same in a sitemap index', () => {
    const xml = renderSitemapIndex([{ url: 'https://example.com/s1', lastModified: bad }]);
    expect(xml).toContain('<loc>https://example.com/s1</loc>');
    expect(xml).not.toContain('<lastmod>');
  });
});
