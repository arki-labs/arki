// Smoke test of ./react, the JSON-LD components rendered on the server. The entry is
// bundler-only (package.json "arki.bundlerOnly": it imports @arki/ui and @arki/icons, which ship
// TypeScript source), so `arki-runtimes` runs this file as a bundle on every engine.

import { createElement } from 'react';

import { BreadcrumbSchema, FAQSchema } from '../../dist/src/react/index.js';

// Hermes has no DOM renderer (react-dom/server needs MessageChannel), so components render elsewhere only.
const canRender = typeof HermesInternal === 'undefined';
const render = async element =>
  canRender ? (await import('react-dom/server')).renderToStaticMarkup(element) : undefined;

const faqHtml = await render(createElement(FAQSchema, { faqs: [{ question: 'Q</script>?', answer: 'A' }] }));
const emptyFaq = await render(createElement(FAQSchema, { faqs: [] }));
const crumbs = await render(
  createElement(BreadcrumbSchema, { siteUrl: 'https://example.com', items: [{ label: 'Home', href: '/' }] }),
);

const checks = [
  [
    'FAQ schema escapes script breakout',
    faqHtml?.includes('</script>?') === false && faqHtml?.includes('\\u003c/script>?') === true,
    canRender,
  ],
  ['FAQ schema with no questions renders nothing', emptyFaq, canRender ? '' : undefined],
  [
    'breadcrumb schema makes absolute urls',
    crumbs?.includes('"item":"https://example.com/"'),
    canRender ? true : undefined,
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
