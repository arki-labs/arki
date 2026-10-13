// Speed of @arki/string against the string libraries most projects use.
// Run: `bun run bench` (explore) or `bun run bench --profile publish --write-readme`.
//
// Every `compare` group states a contract and is checked before timing: each
// ranked library must return the same text for every input, including the
// boundary inputs listed. Libraries that keep a different promise are marked
// `differs` and shown without a ratio; operations where no rival keeps the
// same promise are `scenario` tables, shown without ratios.

// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- loads the local module declaration for an untyped competitor
/// <reference path="./vendor.d.ts" />

import * as changeCase from 'change-case';
import escapeHtmlLib from 'escape-html';
import { camelCase, escape, escapeRegExp, kebabCase, truncate } from 'lodash-es';
import slugifyLib from 'slugify';

import { compare, defineSuite, scenario } from '@arki/bench';
import { camelCase as arkiCamelCase, kebabCase as arkiKebabCase } from '@arki/string/case';
import { escapeHtml as arkiEscapeHtml, escapeRegExp as arkiEscapeRegExp } from '@arki/string/escape';
import { truncate as arkiTruncate } from '@arki/string/format';
import { slugify as arkiSlugify } from '@arki/string/slug';

// Identifiers and phrases, plain ASCII and accented. No apostrophes and no word
// that starts with a digit: change-case keeps a different promise there (see notes).
const identifiers: readonly string[] = [
  'The XMLHttpRequest and naive cafe_user-name & the Quick Brown Fox',
  'fooBarBaz',
  'foo_bar-baz qux',
  'HTTPServer2Go',
  'snake_case_ID',
  '__private__',
  'already-kebab-case',
  '',
  'Crème brûlée façade',
  'naïve_café-déjà vu',
  'Ünïcode Wörld',
];

type Cut = { text: string; max: number };

const cuts: readonly Cut[] = [
  { text: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(4), max: 80 },
  { text: 'Family 👨‍👩‍👧‍👦 trip to the café near the sea', max: 10 },
  { text: 'é'.repeat(20), max: 10 },
  { text: '🇷🇴🇫🇷🇩🇪🇮🇹🇪🇸🇬🇧', max: 5 },
  { text: '각'.repeat(6), max: 4 },
  { text: 'क्षत्रिय क्षत्रिय', max: 4 },
  { text: 'short', max: 80 },
];

const titles: readonly string[] = [
  'Crème brûlée: Ünïcode & Héllo Wörld — 100% done!',
  'Hello World',
  'Straße',
  '  --leading and trailing--  ',
  'fooBar baz',
  '1.5 apples',
];

const markup: readonly string[] = [
  '<a href="/search?q=a&b=2" title=\'Tom & "Jerry"\'>Tom & Jerry</a>',
  'plain text with nothing to escape at all',
  '',
  "it's",
  '`backtick` = {braces}',
  '&amp; already escaped',
  'café <b>naïve</b> 👨‍👩‍👧‍👦 > 3 && x < 5',
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(4) + '<end>',
];

const patterns: readonly string[] = ['price (USD) [a-z]+ * 5.00? ^$ | end', 'abc', '.*', '-x', 'a/b', '{1,2}'];

/** Independent oracle: the five HTML-significant characters, nothing else. */
const escapedHtml = (text: string): string =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

export default defineSuite({
  id: '@arki/string',
  intro:
    'Speed of `@arki/string` against lodash-es, change-case, slugify and escape-html, the libraries most projects use for case conversion, truncation, slugs and escaping. Each table only ranks libraries that returned the same text on every checked input.',
  notes: [
    'Case inputs are identifiers and phrases in plain ASCII and with accents. lodash removes accents (`café` → `cafe`) and, in kebab case, splits letters from digits (`HTTPServer2Go` → `http-server-2-go`), so it is shown but not ranked.',
    "change-case is ranked on inputs without apostrophes and without a word that starts with a digit. On those it differs: `don't stop` gives `donTStop` / `don-t-stop` (`@arki/string`: `dontStop` / `dont-stop`) and `version 2 beta3` gives `version_2Beta3` in camel case (`@arki/string`: `version2Beta3`).",
    '`@arki/string` truncate counts user-perceived characters (graphemes, via `Intl.Segmenter`) and drops whitespace before the ellipsis. lodash `truncate` counts code points joined by a regex for combining marks, emoji sequences and flags: it splits Hangul syllables written as jamo and Devanagari conjuncts, and keeps a space before `…`. The truncate table is not ranked.',
    'Slugs differ by design: `@arki/string` transliterates `ü` to `ue` (German rules), splits camel case (`fooBar` → `foo-bar`), keeps `1.5` as `1-5` and drops `%`; slugify gives `u`, `foobar`, `15` and `percent`. Both are configurable. The slug table is not ranked.',
    '`@arki/string` escapeRegExp follows `RegExp.escape`: it also hex-escapes a leading letter or digit, whitespace and punctuators such as `-` and `,`, so the result is safe after a backslash or inside a character class. lodash escapes only the RegExp syntax characters. The table is not ranked.',
    'escape-html, lodash `escape` and `@arki/string` escape the same five characters (`& < > " \'`) with the same entities, so their HTML table is ranked.',
  ],
  groups: [
    compare<string>({
      id: 'camel-case',
      title: 'camelCase',
      contract: {
        id: 'string-camel-case/v1',
        description: 'lower camel case, split at separators and case changes, accents kept',
      },
      inputs: identifiers,
      baseline: 'arki',
      cases: {
        arki: { label: '@arki/string camelCase', package: '@arki/string', run: (text: string) => arkiCamelCase(text) },
        changeCase: {
          label: 'change-case camelCase',
          package: 'change-case',
          run: (text: string) => changeCase.camelCase(text),
        },
        lodash: {
          label: 'lodash-es camelCase',
          package: 'lodash-es',
          differs: 'removes accents (café → cafe)',
          run: (text: string) => camelCase(text),
        },
      },
    }),
    compare<string>({
      id: 'kebab-case',
      title: 'kebab-case',
      contract: {
        id: 'string-kebab-case/v1',
        description: 'lower kebab case, split at separators and case changes, accents kept',
      },
      inputs: identifiers,
      baseline: 'arki',
      cases: {
        arki: { label: '@arki/string kebabCase', package: '@arki/string', run: (text: string) => arkiKebabCase(text) },
        changeCase: {
          label: 'change-case kebabCase',
          package: 'change-case',
          run: (text: string) => changeCase.kebabCase(text),
        },
        lodash: {
          label: 'lodash-es kebabCase',
          package: 'lodash-es',
          differs: 'removes accents and splits digits (HTTPServer2Go → http-server-2-go)',
          run: (text: string) => kebabCase(text),
        },
      },
    }),
    compare<string>({
      id: 'escape-html',
      title: 'Escape HTML',
      contract: {
        id: 'string-escape-html/v1',
        description: '& < > " \' replaced by &amp; &lt; &gt; &quot; &#39;, everything else unchanged',
      },
      inputs: markup,
      expected: escapedHtml,
      baseline: 'arki',
      cases: {
        arki: {
          label: '@arki/string escapeHtml',
          package: '@arki/string',
          run: (text: string) => arkiEscapeHtml(text),
        },
        escapeHtml: { label: 'escape-html', package: 'escape-html', run: (text: string) => escapeHtmlLib(text) },
        lodash: { label: 'lodash-es escape', package: 'lodash-es', run: (text: string) => escape(text) },
      },
    }),
    scenario<Cut>({
      id: 'truncate',
      title: 'Truncate with …',
      inputs: cuts,
      note: 'Not ranked: different promises. `@arki/string` counts graphemes and drops the space before `…`; lodash counts code points with a regex for combining marks and emoji, so it splits Hangul jamo syllables and Devanagari conjuncts, and keeps the space.',
      cases: {
        arki: {
          label: '@arki/string truncate',
          package: '@arki/string',
          run: ({ text, max }: Cut) => arkiTruncate(text, max),
        },
        lodash: {
          label: 'lodash-es truncate',
          package: 'lodash-es',
          run: ({ text, max }: Cut) => truncate(text, { length: max, omission: '…' }),
        },
      },
    }),
    scenario<string>({
      id: 'slugify',
      title: 'Slugify a title',
      inputs: titles,
      note: 'Not ranked: different transliteration rules (`Ünïcode` → `uenicode` vs `unicode`, `100%` → `100` vs `100percent`, `fooBar` → `foo-bar` vs `foobar`).',
      cases: {
        arki: { label: '@arki/string slugify', package: '@arki/string', run: (text: string) => arkiSlugify(text) },
        slugify: {
          label: 'slugify (lower, strict)',
          package: 'slugify',
          run: (text: string) => slugifyLib(text, { lower: true, strict: true }),
        },
      },
    }),
    scenario<string>({
      id: 'escape-regexp',
      title: 'Escape a string for use in a RegExp',
      inputs: patterns,
      note: 'Not ranked: `@arki/string` follows `RegExp.escape` (`abc` → `\\x61bc`, `-x` → `\\x2dx`); lodash escapes only syntax characters (`abc` → `abc`).',
      cases: {
        arki: {
          label: '@arki/string escapeRegExp',
          package: '@arki/string',
          run: (text: string) => arkiEscapeRegExp(text),
        },
        lodash: { label: 'lodash-es escapeRegExp', package: 'lodash-es', run: (text: string) => escapeRegExp(text) },
      },
    }),
  ],
});
