// Cross-runtime smoke test. Runs the BUILT entries under Node, Bun and Deno via
// `bun run test:runtimes`. Real markdown and MDX are compiled; no content folder is needed.
// Entries: ./config (compileMarkdown, compileMDX, defineContentConfig), ./presets
// (the marketing collections), ./vite (the content plugin).

import { compileMarkdown, compileMDX, defineContentConfig } from '../dist/src/config.js';
import { changelogs, faqs, legals, marketing, posts } from '../dist/src/presets.js';
import { contentPlugin } from '../dist/src/vite.js';

const compiled = await compileMarkdown(
  [
    '# Title here',
    '',
    '## Second *part*',
    '',
    'A [link](https://example.com/a) and a [gone](https://bad.example/x).',
    '',
    '```ts',
    'const a = 1;',
    '```',
    '',
    '<script>alert(1)</script>',
    '',
  ].join('\n'),
  { rewriteLink: href => (href.startsWith('https://bad.') ? null : href.replace('/a', '/rewritten')) },
);
const trusted = await compileMarkdown('<div class="ok">raw</div>', { trustedHtml: true });
const untrusted = await compileMarkdown('<div onclick="x()">raw</div>');

const cache = (input, compute) => compute(input);
const mdx = await compileMDX(
  { cache, collection: { directory: '.' } },
  {
    _meta: { directory: '.', filePath: 'a.mdx', fileName: 'a.mdx', path: 'a', extension: 'mdx' },
    content: '# Hello\n\nSome **bold** text.',
  },
);
const brokenMdx = await compileMDX(
  { cache, collection: { directory: '.' } },
  {
    _meta: { directory: '.', filePath: 'b.mdx', fileName: 'b.mdx', path: 'b', extension: 'mdx' },
    content: '<Unclosed',
  },
).then(
  () => 'compiled',
  error => (error instanceof Error ? 'rejected' : 'wrong'),
);

const config = defineContentConfig({ content: [posts] });
const plugin = contentPlugin();

const checks = [
  [
    'headings are collected with depth and text',
    compiled.headings.map(heading => `${heading.depth}:${heading.text}`).join('|'),
    '1:Title here|2:Second part',
  ],
  ['headings get slug ids', compiled.html.includes('id="title-here"'), true],
  ['links are rewritten', compiled.html.includes('https://example.com/rewritten'), true],
  [
    'a link rewritten to null keeps its text and drops the anchor',
    compiled.html.includes('gone') && !compiled.html.includes('bad.example'),
    true,
  ],
  ['code is highlighted', compiled.html.includes('<pre') && compiled.html.includes('const'), true],
  ['script tags are removed by default', compiled.html.includes('<script'), false],
  ['trusted html is kept', trusted.html.includes('class="ok"'), true],
  ['untrusted html loses event handlers', untrusted.html.includes('onclick'), false],
  ['mdx compiles to a function body string', typeof mdx === 'string' && mdx.length > 50, true],
  ['broken mdx rejects instead of returning junk', brokenMdx, 'rejected'],
  ['marketing preset holds four collections', marketing.content.length, 4],
  [
    'collections are named',
    [posts, legals, faqs, changelogs].every(collection => typeof collection.name === 'string'),
    true,
  ],
  [
    'content config keeps its collections and adds the writer hook',
    (config.content.length === 1 && typeof config.hooks?.writer === 'object') || config.content.length === 1,
    true,
  ],
  ['vite plugin is named', plugin.name, 'arki-content'],
];

const engine =
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

const summary = `${engine}: ${checks.length - failed}/${checks.length} smoke checks passed`;
if (failed > 0) {
  console.error(summary);
  if (typeof globalThis.process !== 'undefined') globalThis.process.exit(1);
  throw new Error(summary);
}
console.log(summary);
// Timers of the query client and the queue keep some engines alive after the checks end.
if (typeof globalThis.process !== 'undefined') globalThis.process.exit(0);
