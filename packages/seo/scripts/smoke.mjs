// Cross-runtime smoke test. Runs the BUILT entries under Node, Bun and Deno via
// `bun run test:runtimes`, and is bundled for the browser and Hermes.
// Entries: root (sitemap, robots, llms.txt, metadata), ./tanstack-start (Meta tags and Head).
// ./react is bundler-only (it imports @arki/ui and @arki/icons, which ship TypeScript source),
// so scripts/smoke/react.mjs proves it as a bundle on every engine.

import { createElement } from 'react';

import {
  createToolMetadata,
  generateLlmsTxt,
  renderRobotsTxt,
  renderSitemapIndex,
  renderUrlset,
  sitemapResponse,
} from '../dist/src/index.js';
import { Head, Meta } from '../dist/src/tanstack-start.js';

// Hermes has no DOM renderer (react-dom/server needs MessageChannel), so components render elsewhere only.
const canRender = typeof HermesInternal === 'undefined';
const render = async element =>
  canRender ? (await import('react-dom/server')).renderToStaticMarkup(element) : undefined;

const urlset = renderUrlset([
  {
    url: 'https://example.com/a?x=1&y=2',
    lastModified: new Date('2026-01-02T00:00:00Z'),
    changeFrequency: 'weekly',
    priority: 0.8,
  },
  { url: 'https://example.com/bad-date', lastModified: new Date('not a date') },
]);
const index = renderSitemapIndex([{ url: 'https://example.com/s/1', lastModified: new Date('2026-01-02T00:00:00Z') }]);
// The Hermes test host has no Response global (a React Native app polyfills it), so the Response helper is checked elsewhere only.
const response = typeof Response === 'undefined' ? undefined : sitemapResponse({ entries: [], cacheSeconds: 60 });
const robots = renderRobotsTxt({ baseUrl: 'https://example.com', disallow: ['/private/'], allowAiBots: ['GPTBot'] });
const llms = generateLlmsTxt({
  name: 'Acme',
  tagline: 'Free tools',
  description: 'About Acme.',
  sections: [
    { heading: 'Tools', items: [{ title: 'Gradient', url: 'https://example.com/g', description: 'Makes gradients' }] },
  ],
});
const metadata = createToolMetadata({
  title: 'Gradient',
  description: 'Design gradients',
  path: '/gradient',
  siteName: 'Acme',
  siteUrl: 'https://example.com',
});
const tags = Meta({
  title: 'Home',
  titleTemplate: '%s | Acme',
  robots: { index: false },
  openGraph: { title: 'Home', images: [{ url: 'https://example.com/i.png', width: 10 }] },
});

const head = await render(createElement(Head, { title: 'Hi', meta: [{ name: 'description', content: 'd' }] }));

const checks = [
  ['urlset escapes ampersands in urls', urlset.includes('<loc>https://example.com/a?x=1&amp;y=2</loc>'), true],
  [
    'urlset keeps priority and frequency',
    urlset.includes('<priority>0.8</priority>') && urlset.includes('<changefreq>weekly</changefreq>'),
    true,
  ],
  ['invalid date is listed without lastmod', urlset.split('<lastmod>').length - 1, 1],
  ['sitemap index renders a sitemap element', index.includes('<sitemap>') && index.includes('<sitemapindex'), true],
  [
    'sitemap response content type',
    response?.headers.get('Content-Type'),
    response ? 'application/xml; charset=utf-8' : undefined,
  ],
  [
    'sitemap response cache',
    response?.headers.get('Cache-Control'),
    response ? 'public, max-age=60, s-maxage=60' : undefined,
  ],
  ['robots disallows the given path', robots.includes('Disallow: /private/'), true],
  [
    'robots allows the given bot and names the sitemap',
    robots.includes('User-agent: GPTBot') && robots.endsWith('Sitemap: https://example.com/sitemap.xml\n'),
    true,
  ],
  ['llms.txt links an item', llms.includes('- [Gradient](https://example.com/g): Makes gradients'), true],
  ['tool metadata canonical path', metadata.alternates.canonical, '/gradient'],
  ['tool metadata open graph title', metadata.openGraph.title, 'Gradient | Acme'],
  ['meta applies the title template', tags[0].content, 'Home | Acme'],
  ['meta emits noindex', tags.find(tag => tag.name === 'robots')?.content, 'noindex, follow'],
  ['meta emits the image width', tags.find(tag => tag.property === 'og:image:width')?.content, '10'],
  [
    'Head renders title and meta',
    head,
    canRender ? '<title>Hi</title><meta name="description" content="d"/>' : undefined,
  ],
];

const runtime =
  typeof HermesInternal !== 'undefined'
    ? 'hermes'
    : typeof Deno !== 'undefined'
      ? `deno ${Deno.version.deno}`
      : typeof Bun !== 'undefined'
        ? `bun ${Bun.version}`
        : typeof navigator !== 'undefined' && navigator.userAgent && !navigator.userAgent.includes('Node')
          ? `browser ${navigator.userAgent}`
          : `node ${globalThis.process?.version ?? ''}`;

let failed = 0;
for (const [name, actual, expected] of checks) {
  if (actual !== expected) {
    failed++;
    console.error(`FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const summary = `${runtime}: ${checks.length - failed}/${checks.length} smoke checks passed`;
if (failed > 0) {
  console.error(summary);
  if (typeof globalThis.process !== 'undefined') globalThis.process.exit(1);
  throw new Error(summary);
}
console.log(summary);
