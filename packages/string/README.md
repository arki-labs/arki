# @arki/string

Zero-dependency string toolkit for TypeScript. Grapheme-aware where it matters,
strict where it counts, and available as plain functions or an immutable fluent
wrapper. Runs in Node 24+, Bun, Deno, browsers, and React Native (Hermes).

## Installation

```sh
npm install @arki/string
# or
bun add @arki/string
# or
pnpm add @arki/string
```

## Two ways to use it

Named functions, tree-shakeable by concern:

```ts
import { toBase64 } from '@arki/string/base64';
import { camelCase } from '@arki/string/case';
import { squish, truncate } from '@arki/string/format';

camelCase('XMLHttpRequest v2Beta'); // 'xmlHttpRequestV2Beta'
truncate('The quick brown fox', 10, { boundary: 'word-before' }); // 'The quick…'
toBase64('crème brûlée 👋', { alphabet: 'url' });
```

Or the immutable fluent wrapper:

```ts
import { str } from '@arki/string/fluent';

str('  XML_http_request  ').squish().titleCase().truncate(24).value(); // 'Xml Http Request'
str('/articles/hello.md').after('/articles/').trimSuffix('.md').value(); // 'hello'
str(' Ada@Example.COM ').trim().lower().value(); // 'ada@example.com'
```

Every method returns a new `StringValue`; nothing mutates. Extract with
`.value()` (or `toString()`, template literals, `JSON.stringify`). Note that
`Boolean(str(''))` is `true` like any object, so use `.isEmpty()`.

The root entry `@arki/string` re-exports everything.

## Unicode model

JavaScript strings are UTF-16: `'👨‍👩‍👧‍👦'.length` is 11 and `.slice()` can
split an emoji in half. Positional functions in this package count **grapheme
clusters** (user-perceived characters) instead:

```ts
import { at, chunk, length, reverse, slice, take } from '@arki/string/unicode';

length('👨‍👩‍👧‍👦'); // 1
at('A👩‍💻B', 1); // '👩‍💻'
take('A👩‍💻B', -2); // '👩‍💻B'
reverse('🇷🇴é'); // 'é🇷🇴'
```

Segmentation uses `Intl.Segmenter` when the engine has it, and an in-house
UAX #29 scanner otherwise (Hermes). The scanner is driven by Unicode property
escapes, so the engine's own tables supply the data, and it is tested against
the official `GraphemeBreakTest` corpus. For UTF-16 units use native `.length`;
for bytes use `utf8Encode`.

Literal searches (`before`, `after`, `replaceFirst`, `ensureStart`, …) only
match on grapheme boundaries, so searching `e` never matches part of `é` in
decomposed form.

## API by concern

| Subpath        | Functions                                                                                                                                                                                                             |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/unicode`     | `graphemes`, `length`, `at`, `slice`, `take`, `reverse`, `splice`, `chunk`, `graphemeBoundaries`                                                                                                                      |
| `/case`        | `caseWords`, `camelCase`, `pascalCase`, `snakeCase`, `kebabCase`, `constantCase`, `dotCase`, `pathCase`, `titleCase`, `sentenceCase`, `capitalize`, `uncapitalize`                                                    |
| `/format`      | `collapseWhitespace`, `squish`, `initials`, `truncate`, `excerpt`, `wrapText`                                                                                                                                         |
| `/segment`     | `lines`, `words`, `wordCount`, `sentences`, `sentenceCount`, `paragraphs`, `paragraphCount`                                                                                                                           |
| `/search`      | `before`, `after`, `between`, `containsAny`, `indexOf`                                                                                                                                                                |
| `/edit`        | `replaceFirst`, `replaceLast`, `replaceStart`, `replaceEnd`, `ensureStart`, `ensureEnd`, `trimPrefix`, `trimSuffix`, `swap`, `deduplicate`, `wrap`, `unwrap`, `mask`, `padStart`, `padEnd`, `padBoth`                 |
| `/escape`      | `escapeHtml`, `escapeRegExp`                                                                                                                                                                                          |
| `/interpolate` | `interpolate`                                                                                                                                                                                                         |
| `/slug`        | `slugify`, `transliterate`, `rulesets` (per-language rule sets)                                                                                                                                                       |
| `/slug-cjk`    | `chinese`, `korean` opt-in rule sets                                                                                                                                                                                  |
| `/base64`      | `toBase64`, `fromBase64`, `tryFromBase64`, `bytesToBase64`, `base64ToBytes`, `utf8Encode`, `utf8Decode`, `byteLength`, `base64` (compat object)                                                                       |
| `/readability` | `syllableCount`, `fleschReadingEase`, `fleschKincaidGrade`, `gunningFog`, `smogIndex`, `colemanLiauIndex`, `automatedReadabilityIndex`, `lix`, `fleschReadingEaseLevel`, `readability`, `readingTime`, `speakingTime` |
| `/keywords`    | `keywords`, `ENGLISH_STOP_WORDS`                                                                                                                                                                                      |
| `/vocabulary`  | `uniqueWordCount`, `wordFrequencies`, `lexicalDiversity`, `yulesK`, `simpsonsDiversityIndex`, `wordLengthStats`                                                                                                       |
| `/metrics`     | `textMetrics` (everything above in one object)                                                                                                                                                                        |
| `/hash`        | `hashCode`                                                                                                                                                                                                            |
| `/fluent`      | `str`, `StringValue`                                                                                                                                                                                                  |

### Case conversion

All case functions share one tokenizer, `caseWords`, so they split identifiers
identically. Tokens are letters, numbers, and marks; digits stay attached to
the preceding token; an uppercase run ends before its last capital when a
lowercase letter follows.

| Input            | Tokens                   | `snakeCase`        |
| ---------------- | ------------------------ | ------------------ |
| `XMLHttpRequest` | `XML`, `Http`, `Request` | `xml_http_request` |
| `v2Beta`         | `v2`, `Beta`             | `v2_beta`          |
| `iPhone11Pro`    | `i`, `Phone11`, `Pro`    | `i_phone11_pro`    |
| `crème brûlée`   | `crème`, `brûlée`        | `crème_brûlée`     |
| `don't-stop`     | `dont`, `stop`           | `dont_stop`        |

Casing is locale-independent unless you pass `{ locale: 'tr' }`; the machine
locale is never used. `titleCase` and `sentenceCase` build labels from tokens
and discard punctuation; `capitalize` only touches the first grapheme.

### Format

- `truncate(text, max, { ellipsis, boundary })` enforces a total grapheme budget
  that includes the ellipsis (`…` by default). `boundary: 'word-before'` backs up
  to the previous word.
- `initials('Ada King Lovelace')` is `'AL'`; `{ pick: 'first' }` gives `'AK'`.
- `squish` is `collapseWhitespace` plus a trim.

### Segment

One definition of a word, sentence, line, and paragraph, shared by every
counting and scoring function in the package. Regular expressions only, so
results are identical on every runtime.

- `words` counts prose words: `don't`, `re-enter`, and `3.14` are one word
  each. Scripts without word spacing yield one word per run.
- `sentences` splits after `.`, `!`, `?`, or `…` followed by whitespace; a
  trailing fragment with a letter or digit counts. `Mr.` is not special-cased.
- `paragraphs` are non-blank lines, so single- and double-newline text agree.
- `lines` splits on CRLF, LF, CR, NEL, LS, and PS and keeps trailing empties.

### Readability, keywords, vocabulary, metrics

```ts
import { keywords } from '@arki/string/keywords';
import { textMetrics } from '@arki/string/metrics';
import { readability, readingTime, syllableCount } from '@arki/string/readability';
import { lexicalDiversity, wordFrequencies } from '@arki/string/vocabulary';

readability(article).fleschKincaidGrade; // 8.4
readingTime(article); // { words: 1200, seconds: 302.5, minutes: 5.04 }
keywords(article, { length: 2, limit: 5 }); // [{ keyword: 'machine learning', occurrences: 7, percentage: 1.9 }, …]
textMetrics(article); // every count, score, and statistic in one object
```

- Syllables use an English heuristic (vowel groups with silent-`e`, `-ed`,
  `-es`, `-le` and hiatus rules). It is meant for readability grades, not for
  hyphenation; words without Latin letters count 0.
- Readability formulas are English-calibrated. Flesch Reading Ease is clamped to
  0–100 and text without words scores 100; the grade indexes return 0.
- `keywords` builds 1-, 2-, or 3-word phrases that never cross clause
  punctuation and never contain a stop word (`ENGLISH_STOP_WORDS` by default,
  `stopWords: null` to disable) or a word under `minWordLength` graphemes.
- Vocabulary functions compare words lowercased; pass `{ locale }` for
  locale-sensitive lowercasing.
- `hashCode` (in `/hash`) is the non-negative Java `String.hashCode` over
  UTF-16 units: stable, fast, and not cryptographic.

## Runtime support

Node 24+, Bun, Deno, every evergreen browser, and React Native (Hermes). The
library uses only ECMAScript 2022 plus Unicode property escapes: no `Buffer`,
`atob`, `TextEncoder`, `node:` imports, or ES2023 array-copy methods. The one
feature check is `Intl.Segmenter`, with an in-house fallback. A lint rule and a
test (`src/runtime.test.ts`) fail the build if any of that changes.

### Base64 and UTF-8

No `Buffer`, `atob`, or `btoa`. Text functions are UTF-8; byte functions take
and return `Uint8Array`. Decoding is strict: whitespace, mixed alphabets, bad
padding, impossible lengths, and nonzero unused bits throw `SyntaxError`;
invalid UTF-8 throws `TypeError`. `tryFromBase64` returns `null` instead.

```ts
toBase64('f'); // 'Zg=='
toBase64('f', { alphabet: 'url' }); // 'Zg'  (url defaults to no padding)
base64ToBytes('/w=='); // Uint8Array [255]
fromBase64('/w=='); // throws TypeError: not UTF-8
```

The `base64` object (`encode`, `decode`, `urlEncode`, `urlDecode`) is kept for
existing consumers; its decoders return `null` on malformed input.

### Slugs

```ts
import { slugify, transliterate } from '@arki/string/slug';

slugify('Привет мир'); // 'privet-mir'
slugify('Nguyễn Đăng Khoa'); // 'nguyen-dang-khoa'
slugify('fooBar & baz'); // 'foo-bar-and-baz'
slugify('Hello World', { separator: '_', lowercase: false }); // 'Hello_World'
slugify('ä ö', { locale: 'sv' }); // 'a-o'  (German default would give 'ae-oe')
transliterate('crème brûlée'); // 'creme brulee'
```

Transliteration covers Latin, Cyrillic, Greek, Arabic, Armenian, Georgian,
Hindi, Burmese, Vietnamese, Yiddish, and more, with curated per-language rule
sets ported from cocur/slugify and the general table from
@sindresorhus/transliterate. Priority is: your `replacements`, then `locale`
overrides, then the curated sets, then the general table, then remaining
diacritics are stripped. Chinese (pinyin) and Korean rule sets are large, so
they are opt-in:

```ts
import { chinese } from '@arki/string/slug-cjk';

slugify('我是谁', { replacements: chinese }); // 'wo-shi-shui'
```

### Interpolation

```ts
interpolate('Hi {{ name }}', { name: 'Ada' }); // 'Hi Ada'
interpolate('{{ missing }}', {}); // throws ReferenceError
interpolate('{{ missing }}', {}, { missing: 'keep' }); // '{{ missing }}'
```

Flat identifier keys only. `null` renders as `''`, `undefined` is missing.
`\{{` emits a literal `{{`. Output is plain text; call `escapeHtml` separately.

## What lives elsewhere

- Validation (`isURL`, `isBase64`): `@arki/assert`.
- HTML parsing, stripping, and sanitizing: `@arki/formats`.
- Dates, durations, relative time: `@arki/date`.
- Hyphenation, dictionaries, embeddings: `@arki/text-*`.
- English pluralization and byte/number formatting: deliberately out of scope.

## Documentation

`@arki/string` is framework-agnostic and works on its own. When you compose
it with the [`@arki/dot`](https://www.npmjs.com/package/@arki/dot)
application framework, see `packages/dot/docs/` for plugin authoring,
lifecycle, and diagnostics.

## License

MIT. See [LICENSE](./LICENSE).
