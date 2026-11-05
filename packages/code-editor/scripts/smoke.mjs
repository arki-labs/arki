// Cross-runtime smoke test. Runs the BUILT entries in headless Chromium via
// `bun run test:runtimes` (the only engine this package claims). Mounts a real CodeMirror
// editor in the page; themes and the theme picker are checked as data and as rendered HTML.

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';

import { CodeEditor } from '../dist/src/editor.js';
import { ThemePicker } from '../dist/src/theme-picker.js';
import { getTheme, themeMap, themes } from '../dist/src/themes.js';

const mount = async props => {
  const host = document.createElement('div');
  document.body.append(host);
  flushSync(() => createRoot(host).render(createElement(CodeEditor, props)));
  for (let attempt = 0; attempt < 100 && !host.querySelector('.cm-content'); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return host;
};

const editable = await mount({ value: '{"a": 1}', language: 'json', ariaLabel: 'Config', lineNumbers: true });
const readOnly = await mount({
  value: 'select 1;',
  language: 'sql',
  readOnly: true,
  theme: getTheme('dracula').extension,
});
const plain = await mount({ value: 'plain text' });

const picker = renderToStaticMarkup(createElement(ThemePicker, { value: 'nord', onChange: () => {} }));

const checks = [
  ['editor shows the given text', editable.querySelector('.cm-content')?.textContent, '{"a": 1}'],
  ['editor carries the aria label', editable.querySelector('.cm-content')?.getAttribute('aria-label'), 'Config'],
  ['editor shows line numbers when asked', editable.querySelector('.cm-lineNumbers') !== null, true],
  [
    'editable editor is not marked read-only',
    editable.querySelector('.cm-content')?.getAttribute('aria-readonly'),
    null,
  ],
  [
    'read-only editor is marked read-only',
    readOnly.querySelector('.cm-content')?.getAttribute('aria-readonly'),
    'true',
  ],
  ['read-only editor shows its text', readOnly.querySelector('.cm-content')?.textContent, 'select 1;'],
  ['unknown language falls back to plain text', plain.querySelector('.cm-content')?.textContent, 'plain text'],
  ['thirteen themes are registered', themes.length, 13],
  ['theme map finds a theme by id', themeMap.get('nord')?.label, 'Nord'],
  ['an unknown theme id falls back to github-dark', getTheme('no-such-theme').id, 'github-dark'],
  ['theme picker renders its trigger', picker.includes('Code editor theme'), true],
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
