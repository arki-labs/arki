// Cross-runtime smoke test. Runs the BUILT entry in headless Chromium via
// `bun run test:runtimes` (the only engine this package claims). Components are
// rendered to HTML with react-dom/server; the markdown hook is mounted in a real DOM.

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';

import { ContentSection, DateTime, Notification, Timeline, useProcessor } from '../dist/src/index.js';

const goodDate = renderToStaticMarkup(createElement(DateTime, { value: '2026-03-04T10:00:00Z' }));
// Front matter is outside text: an unreadable date is shown as written, not thrown.
const badDate = renderToStaticMarkup(createElement(DateTime, { value: 'not a date' }));
const notice = renderToStaticMarkup(createElement(Notification, { type: 'error', title: 'Careful' }, 'Body text'));
const section = renderToStaticMarkup(createElement(ContentSection, { className: 'extra' }, 'Inside'));
const timeline = renderToStaticMarkup(createElement(Timeline, { title: 'Posts', description: 'All posts' }, 'Rows'));

function Markdown() {
  const { value } = useProcessor('Hello [site](https://example.com)');
  return createElement('div', { id: 'out' }, value);
}
const host = document.createElement('div');
document.body.append(host);
flushSync(() => createRoot(host).render(createElement(Markdown)));
for (let attempt = 0; attempt < 50 && !host.querySelector('a'); attempt++) {
  await new Promise(resolve => setTimeout(resolve, 20));
}
const link = host.querySelector('a');

const checks = [
  ['DateTime formats a valid instant', goodDate.includes('>2026-03-04</time>'), true],
  ['DateTime keeps the machine value', goodDate.includes('dateTime="2026-03-04T10:00:00Z"'), true],
  ['DateTime shows unreadable text as written', badDate.includes('>not a date</time>'), true],
  ['Notification shows its title and body', notice.includes('Careful') && notice.includes('Body text'), true],
  ['Notification error type has the error border', notice.includes('border-error-600'), true],
  ['ContentSection keeps the extra class', section.includes('extra') && section.includes('Inside'), true],
  [
    'Timeline renders heading, description and rows',
    timeline.includes('<h1') && timeline.includes('All posts') && timeline.includes('Rows'),
    true,
  ],
  ['useProcessor renders markdown to a link', link?.getAttribute('href'), 'https://example.com'],
  ['useProcessor opens links in a new tab', link?.getAttribute('target'), '_blank'],
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
