/**
 * Framework-agnostic sitemap.xml builders.
 *
 * Apps invoke `sitemapResponse(...)` from a server handler (TanStack Start
 * route, Hono handler, plain Node) and return the resulting `Response`.
 * Crawlers parse responses by `Content-Type: application/xml`, so the URL
 * extension doesn't matter for sharded sitemaps that need dynamic segments.
 *
 * - Static sitemap: `sitemapResponse({ entries })`
 * - Sitemap index pointing at shards: `sitemapIndexResponse({ shards })`
 */

const DEFAULT_CACHE_SECONDS = 3_600; // 1 hour

const SITEMAP_NS = 'http://www.sitemaps.org/schemas/sitemap/0.9';

export type ChangeFreq =
  | 'always'
  | 'hourly'
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'yearly'
  | 'never';

export type SitemapEntry = {
  /** Absolute URL of the page. Will be XML-escaped automatically. */
  url: string;
  /** Date the page was last modified. */
  lastModified: Date;
  /** Hint for crawlers about how often the page changes. Optional. */
  changeFrequency?: ChangeFreq;
  /** SEO weight 0.0–1.0. Optional; defaults to omitted (search engines treat as 0.5). */
  priority?: number;
};

export type SitemapIndexEntry = {
  /** Absolute URL of the shard sitemap. Will be XML-escaped automatically. */
  url: string;
  /** Date the shard was last regenerated. */
  lastModified: Date;
};

const escapeXml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

const toIsoDate = (date: Date) => date.toISOString();

const renderUrlEntry = (entry: SitemapEntry) => {
  const lines = [
    '  <url>',
    `    <loc>${escapeXml(entry.url)}</loc>`,
    `    <lastmod>${toIsoDate(entry.lastModified)}</lastmod>`,
  ];
  if (entry.changeFrequency) {
    lines.push(`    <changefreq>${entry.changeFrequency}</changefreq>`);
  }
  if (typeof entry.priority === 'number') {
    lines.push(`    <priority>${entry.priority.toFixed(1)}</priority>`);
  }
  lines.push('  </url>');
  return lines.join('\n');
};

const renderIndexEntry = (entry: SitemapIndexEntry) =>
  [
    '  <sitemap>',
    `    <loc>${escapeXml(entry.url)}</loc>`,
    `    <lastmod>${toIsoDate(entry.lastModified)}</lastmod>`,
    '  </sitemap>',
  ].join('\n');

/**
 * Renders a sitemap urlset XML body.
 * Use directly when you need the raw string; otherwise prefer `sitemapResponse`.
 */
export function renderUrlset(entries: readonly SitemapEntry[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<urlset xmlns="${SITEMAP_NS}">`,
    ...entries.map(entry => renderUrlEntry(entry)),
    '</urlset>',
    '',
  ].join('\n');
}

/**
 * Renders a sitemap index XML body that points at sharded sitemaps.
 * Use when a single sitemap would exceed the 50,000-URL Google limit.
 */
export function renderSitemapIndex(entries: readonly SitemapIndexEntry[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<sitemapindex xmlns="${SITEMAP_NS}">`,
    ...entries.map(entry => renderIndexEntry(entry)),
    '</sitemapindex>',
    '',
  ].join('\n');
}

const xmlResponse = (body: string, cacheSeconds: number) =>
  new Response(body, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': `public, max-age=${cacheSeconds}, s-maxage=${cacheSeconds}`,
    },
  });

/**
 * Builds a complete `Response` for a `/sitemap.xml` route.
 * Sets `Content-Type: application/xml; charset=utf-8` and a 1-hour cache by default.
 *
 * @example
 * ```ts
 * sitemapResponse({
 *   entries: [
 *     { url: 'https://example.com', lastModified: new Date(), changeFrequency: 'weekly', priority: 1 },
 *     { url: 'https://example.com/about', lastModified: new Date(), changeFrequency: 'monthly' },
 *   ],
 * });
 * ```
 */
export function sitemapResponse(options: {
  entries: readonly SitemapEntry[];
  cacheSeconds?: number;
}): Response {
  return xmlResponse(renderUrlset(options.entries), options.cacheSeconds ?? DEFAULT_CACHE_SECONDS);
}

/**
 * Builds a complete `Response` for a sitemap index that points at shard sitemaps.
 *
 * @example
 * ```ts
 * sitemapIndexResponse({
 *   shards: shardIds.map(id => ({
 *     url: `${baseUrl}/sitemap/${id}`,
 *     lastModified: new Date(),
 *   })),
 * });
 * ```
 */
export function sitemapIndexResponse(options: {
  shards: readonly SitemapIndexEntry[];
  cacheSeconds?: number;
}): Response {
  return xmlResponse(
    renderSitemapIndex(options.shards),
    options.cacheSeconds ?? DEFAULT_CACHE_SECONDS,
  );
}
