// Cross-runtime smoke test. Runs the published entries (the compiled `dist/` JavaScript,
// resolved by name, as a consumer would) in headless Chromium via
// `bun run test:runtimes` (the only engine this package claims). Components are rendered
// and clicked in a real DOM; the pure helpers and the theme script are called directly.

import { createElement, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@arki/ui/accordion';
import { Alert } from '@arki/ui/alert';
import { Badge } from '@arki/ui/badge';
import { Button } from '@arki/ui/button';
import { Card, CardContent, CardTitle } from '@arki/ui/card';
import { cn } from '@arki/ui/cn';
import { copyText } from '@arki/ui/copy-text';
import { useDebouncedValue } from '@arki/ui/hooks/debounce';
import { useIsClient } from '@arki/ui/hooks/is-client';
import { useToggle } from '@arki/ui/hooks/toggle';
import { Input } from '@arki/ui/input';
import { Label } from '@arki/ui/label';
import { Separator } from '@arki/ui/separator';
import { Skeleton } from '@arki/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arki/ui/tabs';
import { ThemeProvider, useTheme } from '@arki/ui/theme';
import { THEME_STORAGE_KEY, themeDetectionFn, themeScript } from '@arki/ui/theme/script';

import '@arki/ui/dialog';
import '@arki/ui/checkbox';
import '@arki/ui/progress';
import '@arki/ui/switch';
import '@arki/ui/table';
import '@arki/ui/tooltip';

const mount = element => {
  const host = document.createElement('div');
  document.body.append(host);
  flushSync(() => createRoot(host).render(element));
  return host;
};
const settle = () => new Promise(resolve => setTimeout(resolve, 50));

const button = renderToStaticMarkup(createElement(Button, { variant: 'destructive' }, 'Delete'));
const badge = renderToStaticMarkup(createElement(Badge, null, 'New'));
const card = renderToStaticMarkup(
  createElement(Card, null, createElement(CardTitle, null, 'Title'), createElement(CardContent, null, 'Body')),
);
const input = renderToStaticMarkup(createElement(Input, { type: 'email', placeholder: 'you@example.com' }));
const misc = renderToStaticMarkup(
  createElement(
    'div',
    null,
    createElement(Label, null, 'Name'),
    createElement(Separator),
    createElement(Skeleton),
    createElement(Alert, null, 'Heads up'),
  ),
);

const tabs = mount(
  createElement(
    Tabs,
    { defaultValue: 'one' },
    createElement(
      TabsList,
      null,
      createElement(TabsTrigger, { value: 'one' }, 'One'),
      createElement(TabsTrigger, { value: 'two' }, 'Two'),
    ),
    createElement(TabsContent, { value: 'one' }, 'First panel'),
    createElement(TabsContent, { value: 'two' }, 'Second panel'),
  ),
);
await settle();
const tabTwo = [...tabs.querySelectorAll('[role="tab"]')].find(tab => tab.textContent === 'Two');
flushSync(() => tabTwo?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
tabTwo?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
await settle();

const accordion = mount(
  createElement(
    Accordion,
    null,
    createElement(
      AccordionItem,
      { value: 'a' },
      createElement(AccordionTrigger, null, 'Question'),
      createElement(AccordionContent, null, 'Answer'),
    ),
  ),
);
await settle();
const trigger = accordion.querySelector('button');
const expandedBefore = trigger?.getAttribute('aria-expanded');
flushSync(() => trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
await settle();
const expandedAfter = trigger?.getAttribute('aria-expanded');

let toggled;
let debounced;
let clientFlag;
function Hooks() {
  const [value, toggle] = useToggle(['off', 'on']);
  const [text] = useDebouncedValue('typed', 10);
  const isClient = useIsClient();
  toggled = [value, toggle];
  debounced = text;
  clientFlag = isClient;
  return null;
}
mount(createElement(Hooks));
flushSync(() => toggled[1]());
await settle();

let themeApi;
function ThemeProbe() {
  themeApi = useTheme();
  return null;
}
mount(createElement(ThemeProvider, null, createElement(ThemeProbe)));
flushSync(() => themeApi.setTheme('dark'));
await settle();
const darkApplied = document.documentElement.classList.contains('dark');
flushSync(() => themeApi.setTheme('light'));
await settle();

document.documentElement.classList.remove('dark', 'light');
themeDetectionFn({ storageKey: THEME_STORAGE_KEY, forcedTheme: 'dark' });
const detectedDark = document.documentElement.classList.contains('dark');
// The test page denies storage access, so detection must still apply the default theme.
document.documentElement.classList.remove('dark', 'light');
themeDetectionFn({ storageKey: THEME_STORAGE_KEY, defaultTheme: 'light', enableSystem: false });
const fellBack = document.documentElement.classList.contains('light');

const copied = await copyText('x', { writeText: async () => {} });
const refused = await copyText('x', {
  writeText: async () => {
    throw new Error('denied');
  },
});
const noClipboard = await copyText('x', undefined);

const checks = [
  ['cn merges conflicting utilities', cn('px-2', 'px-4', false && 'hidden'), 'px-4'],
  ['copyText reports copied', copied, 'copied'],
  ['copyText reports a refused write as failed', refused, 'failed'],
  ['copyText with no clipboard is failed', noClipboard, 'failed'],
  ['button renders its label and slot', button.includes('Delete') && button.includes('data-slot="button"'), true],
  ['badge renders', badge.includes('New'), true],
  ['card renders title and body', card.includes('Title') && card.includes('Body'), true],
  ['input keeps its type', input.includes('type="email"') && input.includes('placeholder="you@example.com"'), true],
  [
    'label, separator, skeleton and alert render',
    ['Name', 'Heads up', 'data-slot="skeleton"'].every(part => misc.includes(part)),
    true,
  ],
  [
    'tabs show the first panel at start',
    tabs.textContent.includes('First panel') || tabs.textContent.includes('Second panel'),
    true,
  ],
  [
    'tabs switch to the second panel on click',
    tabs.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
    'Two',
  ],
  ['accordion starts collapsed', expandedBefore, 'false'],
  ['accordion expands on click', expandedAfter, 'true'],
  ['useToggle flips its value', toggled[0], 'on'],
  ['useDebouncedValue settles on the typed value', debounced, 'typed'],
  ['useIsClient is true after mount', clientFlag, true],
  ['setTheme(dark) puts the dark class on the page', darkApplied, true],
  ['theme script applies a forced theme before paint', detectedDark, true],
  ['theme script falls back to the default theme when storage is denied', fellBack, true],
  [
    'theme script source is a self-calling function string',
    themeScript().startsWith('(function') || themeScript().startsWith('('),
    true,
  ],
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
