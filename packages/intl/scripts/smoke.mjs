// Cross-runtime smoke test. Runs the BUILT entries under Node, Bun and Deno via
// `bun run test:runtimes`, and is bundled for the browser and Hermes.
// Entries: ./language, ./dictionaries, ./slug-registry, ./types (type-only, import only),
// ./react (type-only), ./tanstack-start (providers rendered on the server).

import { createElement } from 'react';

import { loadMessagesFromMultipleDictionaries } from '../dist/src/dictionaries.js';
import { getEnglishName, getNativeName, isLanguageCode, isValid } from '../dist/src/language.js';
import { SlugRegistry } from '../dist/src/slug-registry.js';

import '../dist/src/types.js';
import '../dist/src/react.js';

import {
  AppLocaleProvider,
  hasLocale,
  LocaleProvider,
  useLocale,
  useTranslations,
} from '../dist/src/integrations/tanstack-start/index.js';

// Hermes has no DOM renderer (react-dom/server needs MessageChannel), so providers render elsewhere only.
const canRender = typeof HermesInternal === 'undefined';
const render = async element =>
  canRender ? (await import('react-dom/server')).renderToStaticMarkup(element) : undefined;

const german = await loadMessagesFromMultipleDictionaries('de', 'en', [
  { de: () => ({ PostsTimeline: { extra: 'x' } }), en: () => ({}) },
]);
const fallback = await loadMessagesFromMultipleDictionaries('fr', 'en', []);
const unknown = await loadMessagesFromMultipleDictionaries('__proto__', 'zz', []);

const registry = new SlugRegistry([{ resourceId: 'fmt', locale: 'de', slug: 'formatierer', scope: 'json' }]);

function Probe() {
  const t = useTranslations('PostsTimeline');
  return createElement('span', null, `${useLocale()}:${t('title')}`);
}
const html = await render(createElement(AppLocaleProvider, { locale: 'de' }, createElement(Probe)));
const plainHtml = await render(
  createElement(LocaleProvider, { locale: 'en', messages: { PostsTimeline: { title: 'Mine' } } }, createElement(Probe)),
);

const checks = [
  ['english name of de', getEnglishName('de'), 'German'],
  ['native name of de', getNativeName('de'), 'Deutsch'],
  ['unknown code is not valid', isValid('zz9'), false],
  ['en-US is a language tag', isLanguageCode('en-US').res, true],
  [
    'xx-QQ-9 is refused with a reason',
    `${isLanguageCode('xx-QQ-9').res}:${isLanguageCode('xx-QQ-9').message}`,
    'false:Unrecognised language subtag, "xx".',
  ],
  [
    'german dictionary loads and merges feature keys',
    `${german.PostsTimeline.title}/${german.PostsTimeline.extra}`,
    'Beiträge/x',
  ],
  ['missing locale falls back to the default dictionary', fallback.PostsTimeline.title, 'Posts'],
  ['unknown locale and default load nothing', Object.keys(unknown).length, 0],
  ['slug forward lookup', registry.getSlug('fmt', 'de'), 'formatierer'],
  ['slug reverse lookup in scope', registry.getResourceId('formatierer', 'de', 'json'), 'fmt'],
  ['localized url', registry.getLocalizedUrl('fmt', 'de', 'en', '/json/formatter/'), '/de/json/formatierer/'],
  ['unknown slug has no resource', registry.getResourceId('nope', 'de'), undefined],
  ['hasLocale is re-exported', hasLocale(['en', 'de'], 'de'), true],
  ['AppLocaleProvider serves built-in german messages', html, canRender ? '<span>de:Beiträge</span>' : undefined],
  ['LocaleProvider serves given messages', plainHtml, canRender ? '<span>en:Mine</span>' : undefined],
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
