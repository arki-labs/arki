// Cross-runtime smoke test, run by `arki-runtimes` on every engine. The package ships TypeScript source for
// bundlers, and `@arki/rss` does too, so `test:runtimes` first bundles `src/index.ts` (with its dependencies)
// to `.cache/runtimes-dist/index.js`. Each engine then builds a feed, parses it back, and searches an index
// after a JSON round trip, so a runtime gap fails loudly.

import {
  buildChangelogFeed,
  buildPostFeed,
  createPostSearchIndex,
  loadPostSearchIndex,
  searchPosts,
} from '../.cache/runtimes-dist/index.js';

const runtime = globalThis.Deno
  ? `deno ${globalThis.Deno.version.deno}`
  : globalThis.Bun
    ? `bun ${globalThis.Bun.version}`
    : globalThis.process?.versions?.node
      ? `node ${globalThis.process.version}`
      : typeof globalThis.HermesInternal === 'undefined'
        ? 'browser'
        : 'hermes';
const checks = [];
const check = (name, actual, expected) => checks.push({ name, ok: actual === expected, actual, expected });

const site = { appTitle: 'Acme & Co', appDomain: 'acme.test', appLink: 'https://acme.test', now: new Date(0) };
const publishedAt = new Date('2026-01-01T00:00:00Z');
const posts = [
  {
    url: '/posts/widgets',
    slug: 'widgets',
    title: 'Widgets <3',
    description: 'All about widgets',
    publishedAt,
    readingTime: '1 min read',
    image: { url: '/posts/widgets/cover.jpg' },
    author: { name: 'Ada' },
    tags: ['widgets'],
    content: { raw: 'we looked at widgets' },
  },
  {
    url: '/posts/gadgets',
    slug: 'gadgets',
    title: 'Gadgets',
    description: 'Something else',
    publishedAt,
    readingTime: '2 min read',
    image: { url: '/posts/gadgets/cover.jpg' },
    author: { name: 'Bo' },
    tags: [],
    content: { raw: 'nothing about it' },
  },
];

const postFeed = buildPostFeed(posts, site);
check('post feed escapes', postFeed.includes('<title>Widgets &lt;3</title>'), true);
check('post feed link', postFeed.includes('<link>https://acme.test/posts/widgets</link>'), true);
const changelogFeed = buildChangelogFeed([{ slug: 'v1', title: 'v1', description: 'First', publishedAt }], site);
check('changelog feed credits the team', changelogFeed.includes('Acme &amp; Co Team'), true);

const index = loadPostSearchIndex(JSON.stringify(createPostSearchIndex(posts)));
const [hit] = searchPosts(index, 'widgets');
check('search after JSON round trip', hit?.id, '/posts/widgets');
check('search stores the overview', hit?.readingTime, '1 min read');
check('search keeps the body out', hit?.content, undefined);

const failed = checks.filter(c => !c.ok);
for (const c of failed) console.error(`✗ ${c.name}: expected ${String(c.expected)}, got ${String(c.actual)}`);
console.log(`${runtime}: ${checks.length - failed.length}/${checks.length} smoke checks passed`);
if (failed.length > 0) throw new Error(`${failed.length} smoke check(s) failed on ${runtime}`);
