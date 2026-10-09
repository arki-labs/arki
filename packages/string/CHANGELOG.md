# @arki/string

## 0.1.0

### Minor Changes

- Rebuilt as a zero-dependency string toolkit. `@poppinss/utils` and `voca` are gone; every function is implemented in-house and runs in Node 24+, Bun, Deno, browsers, and React Native (Hermes). Library source is limited to ES2022 plus Unicode property escapes, enforced by a lint rule and `src/runtime.test.ts`.

  **New**
  - `/unicode`: grapheme-aware `length`, `at`, `slice`, `take`, `reverse`, `splice`, `chunk`, `graphemes`. Uses `Intl.Segmenter` when available and an in-house UAX #29 scanner otherwise, tested against the official GraphemeBreakTest corpus.
  - `/case`: one tokenizer (`caseWords`) behind `camelCase`, `pascalCase`, `snakeCase`, `kebabCase`, `constantCase`, `dotCase`, `pathCase`, `titleCase`, `sentenceCase`, `capitalize`, `uncapitalize`; explicit `locale` option, never the machine locale.
  - `/format`: `collapseWhitespace`, `squish`, `initials`, `truncate` (grapheme budget incl. ellipsis, optional word boundary), `excerpt`, `wrapText`.
  - `/segment`: `lines`, `words`, `wordCount`, `sentences`, `sentenceCount`, `paragraphs`, `paragraphCount` — the one word/sentence/paragraph definition every count and score in the package uses.
  - `/search`: `before`, `after`, `between`, `containsAny`, `indexOf` — literal matches align to grapheme boundaries.
  - `/edit`: `replaceFirst`, `replaceLast`, `replaceStart`, `replaceEnd`, `ensureStart`, `ensureEnd`, `trimPrefix`, `trimSuffix`, `swap` (single pass, longest key wins), `deduplicate`, `wrap`, `unwrap`, `mask`, grapheme-counted `padStart`/`padEnd`/`padBoth`.
  - `/readability`: English `syllableCount` heuristic; `fleschReadingEase`, `fleschKincaidGrade`, `gunningFog`, `smogIndex`, `colemanLiauIndex`, `automatedReadabilityIndex`, `lix`, `fleschReadingEaseLevel`, `readability` (all at once); `readingTime` and `speakingTime` returning `{ words, seconds, minutes }`.
  - `/keywords`: `keywords(text, { length, limit, minWordLength, minOccurrences, stopWords, locale })` for 1-, 2-, or 3-word phrases that never cross clause punctuation; `ENGLISH_STOP_WORDS`.
  - `/vocabulary`: `uniqueWordCount`, `wordFrequencies`, `lexicalDiversity`, `yulesK`, `simpsonsDiversityIndex`, `wordLengthStats` (graphemes).
  - `/metrics`: `textMetrics(text)` — every count, score, and statistic in one object, for word-counter style dashboards.
  - `/hash`: `hashCode` — non-negative Java `String.hashCode` over UTF-16 units.
  - `/escape`: `escapeHtml`, `escapeRegExp` (`RegExp.escape` semantics).
  - `/interpolate`: `{{ name }}` templating with a `missing` policy.
  - `/base64`: `toBase64`, `fromBase64`, `tryFromBase64`, `bytesToBase64`, `base64ToBytes`, `utf8Encode`, `utf8Decode`, `byteLength`. Strict RFC 4648 decoding; no `Buffer`, so it is browser-safe.
  - `/slug`: `slugify` and `transliterate` with curated multi-script rule sets, absorbed from `@arki/slugify` (now removed); `/slug-cjk` holds the opt-in Chinese and Korean sets. Locale overrides now take priority over the curated sets, and lowercasing is locale-independent after transliteration, so `slugify('İstanbul', { locale: 'tr' })` is `istanbul`.
  - `/fluent`: immutable `str()` wrapper exposing every function as a method plus `when`, `pipe`, `tap`, `map`, `test`, `scan`, and grapheme iteration.

  **Breaking**
  - `@arki/string/utils` and `@arki/string/builder` (re-exports of `@poppinss/utils`) are removed. Slugs live in `@arki/slugify`; pluralization, byte/duration formatting, `uuid`, `random`, and path helpers are out of scope.
  - `base64.encode`/`urlEncode` accept `string | Uint8Array | ArrayBuffer` and no longer take a `BufferEncoding`. `base64.decode`/`urlDecode` take one argument and return `string | null`; use `fromBase64` for a throwing decoder. Decoding is strict (canonical padding, no whitespace).
  - `@arki/slugify` is retired; import `slugify` from `@arki/string/slug` instead. Its three unused pinyin dependencies are dropped.
  - `@arki/text-metrics`, `@arki/text-transformations`, `@arki/text-tokenizer`, and `@arki/text-syllables` are retired and their used parts live here (`/readability`, `/keywords`, `/vocabulary`, `/metrics`, `/hash`, `wordCount` in `/segment`). Differences from those packages:
    - Words come from `words()`: `don't`, `re-enter`, and `3.14` are one word each (lodash split them), so word counts and every per-word score can differ.
    - Syllables come from an in-house heuristic instead of `talisman`'s sonority syllabifier, which counted `cake` as 2 and `queue` as 3; readability grades shift accordingly.
    - `getTextMetrics` is `textMetrics`; `getAllKeywordStats` is three `keywords()` calls (`length: 1 | 2 | 3`) with stop words excluded; `stringToUniqueInteger` is `hashCode` (now a true int32, so values differ for long inputs); `countWords` is `wordCount`.
    - Dropped: the Dale-Chall grade (needed the `dale-chall` word list), the "Dale-Chall score" that was really a six-letter proxy, `handWritingTime`, `countPages`, `detectLanguagePatterns`, TF-IDF over sentences, lorem ipsum, and the duplicate case/encoding helpers. Time estimates are numbers, not formatted strings; averages are no longer rounded up.
  - `countCharacters` is deprecated. It keeps its UTF-16 contract; use `length()` for graphemes.

## 0.0.2

### Patch Changes

- Ship TypeScript source in the npm tarball (`src/**` added to `files`). npm installs and the read-only GitHub mirrors now carry the original `.ts` source alongside compiled `dist/` — better debuggability on the experimental track. No runtime changes.

## 0.0.1

### Initial release

- First public publication on npm (experimental track) — 2026-05-21.

  Part of **Wave 1**, the ARKI foundation: zero-dependency utilities and runtime primitives shipped together because every downstream wave (DOT kernel, infrastructure adapters) consumes them. Wave 1 packages: `assert`, `clock`, `contracts`, `date`, `env`, `log`, `resilience`, `slugify`, `string`, `ts`.

  **Why 0.0.x, not 1.0.0**: ARKI is on an experimental track. The 0.0.x prefix is an honest signal — APIs may change without semver discipline until the kernel is field-tested. The release scorecard (metadata, privacy, dependencies, build-output, packlist, docs, fixtures, DOT gates, agent-native gates) is satisfied at this version; the gate certifies _the artifact_, not _API stability_. Stability is earned through reuse, not declared at first publication.

  Wave 2 (`@arki/dot`) and Wave 3 (`@arki/db`, `@arki/kv`, `@arki/event-sourcing`) publish in subsequent releases once their inter-package transitive resolution against the public npm registry is verified.
