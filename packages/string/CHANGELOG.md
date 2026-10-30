# @arki/string

## 0.4.1

### Patch Changes

- fb2103b: Fix runtime failures that plain input could trigger.

  - `@arki/string`: `words`, `wordCount` and every count built on them scan text in linear steps. One regex with a repeating group overflowed the engine's stack on Node for megabytes of text such as `a-a-a-`. Results on ordinary text are unchanged.
  - `@arki/chat-ui`: the `CodeBlock` copy button awaits the clipboard write. A refused write shows "Copy failed" for 2 seconds instead of an unhandled rejection.
  - `@arki/content-react`: a markdown image with no alt text renders as a decorative image (`alt=""`) instead of throwing during render, and an image with no source renders nothing. The code-block copy button shows a failed state when the clipboard is refused or missing. `useSearch` adds `isError` and `retry()`.
  - `@arki/ui`: the sidebar logs through `@arki/log` instead of `debug`, so importing it no longer reads `process.env.DEBUG` (Deno without env permission threw at import). Its debug output now follows the app's `@arki/log` configuration. A refused cookie write no longer throws; the sidebar just does not remember its state.

## 0.4.0

### Minor Changes

- 4e63bb1: Return canonical MissingValue failures from interpolation and its fluent wrapper instead of throwing for absent runtime values. Rename missing: throw to missing: fail, remove the retired E005 diagnostic, and preserve explicit keep/empty recovery. Failure metadata contains no template or supplied values.

  Upgrade guidance and package examples cover result narrowing. No demo impact: no demo interpolation caller was found in the source audit.

- dbc6ee5: Remove `tryFromBase64`; use `fromBase64` with the same options and exact returned failures. Remove obsolete E002/E003 codec diagnostics from `STRING_ERROR_CODES` and its inferred `StringErrorCode`; E001/E004 static misuse remains. Upgrade guidance is in the package docs.

  No demo impact: no demo imports the removed exports.

### Patch Changes

- Updated dependencies [11c5bc2]
- Updated dependencies [a905468]
- Updated dependencies [11c5bc2]
- Updated dependencies [49517e2]
- Updated dependencies [1a897f8]
- Updated dependencies [cac4bc6]
  - @arki/failure@0.3.0

## 0.3.0

### Minor Changes

- baecec3: Return canonical InvalidUtf8 and InvalidBase64 failures for malformed encoding input, with unwrapped successes and exact inferred unions. Encoding failures no longer throw StringError. Fluent codecs require failure narrowing before chaining. Breaking: tryFromBase64 aliases fromBase64 and returns its canonical failures instead of null; replace null checks and catches with isFailure. Add @arki/failure as the sole runtime dependency. Valid bytes and strict decoding rules are unchanged.
- 1668156: Breaking: every deliberate failure is now a `StringError` with a stable code (`ARKI_STRING_E001` to `E005`, exported as `STRING_ERROR_CODES`, subpath `@arki/string/errors`) and a `remediation`. It replaces the built-in `TypeError`, `RangeError`, `SyntaxError` and `ReferenceError` these functions threw. Match on `error.code`.

### Patch Changes

- abffdfd: Docs standard: README sections, `AGENTS.md`, `llms.txt`, an agent guide, a tested `examples/describe-post.ts`, a runtimes table, and `@fix` / `@verify` notes on every error code. no demo impact: documentation and doc-example changes only, runtime behaviour unchanged
- 6029b75: Faster `camelCase` and `pascalCase`: capitalizing a word no longer starts `Intl.Segmenter` when the first letter is plain Latin text (about 12× faster on mixed identifiers).

  Faster case conversion on ASCII text: `caseWords` and every case function built on it split ASCII input in one pass instead of five regular expressions, with the same tokens.

  Faster `truncate` and `length`: text below U+0300 (ASCII and Latin-1/Latin Extended letters) is counted without `Intl.Segmenter`, and `truncate` reads only the first `maxLength + 1` graphemes instead of segmenting the whole text.

- Updated dependencies [57313a4]
- Updated dependencies [f43d509]
- Updated dependencies [232d3e8]
- Updated dependencies [3f6d39f]
- Updated dependencies [7f9b4bb]
- Updated dependencies [86efafc]
- Updated dependencies [d541df1]
- Updated dependencies [f6a15d0]
- Updated dependencies [4913009]
- Updated dependencies [232d3e8]
- Updated dependencies [73ef41b]
- Updated dependencies [f796e5a]
  - @arki/failure@0.1.0

## 0.2.0

### Minor Changes

- Performance and correctness pass after an independent review (Astra).
  - Grapheme fallback (Hermes): emoji tag sequences such as the England flag are one grapheme (tag characters were classed as controls), and a second ZWJ no longer joins two pictographs, matching `Intl.Segmenter`. GB9c follows Unicode 18 (a linker joins the next consonant even without a preceding consonant), which ICU through Unicode 17 does not yet do.
  - `length`, `at`, `slice`, `take`, `chunk`, `capitalize`, and prefix/suffix checks scan only as far as needed instead of materializing every boundary: `at(text, 5)` on 100k characters went from 5.9 ms to 0.05 ms.
  - `sentences()` is linear: 16k consecutive terminal marks went from 1.1 s to 0.03 ms.
  - `slugify`/`transliterate` compile a user replacement table once per array instance (20 calls with the Chinese table: 136 ms → 6 ms).
  - `textMetrics` analyzes the text once (10k words: 341 ms → 104 ms) and no longer hits the engine argument limit on very long texts.
  - `str().length` is cached; `excerpt` and literal searches short-circuit on a native miss.
  - Replacement strings are literal everywhere: `deduplicate` and `slugify({ separator })` no longer interpret `$&`.
  - `keywords` tokenizes with `words()`: `alpha,beta` never forms a phrase across the comma, decomposed accents are kept, and `length`, `limit`, `minWordLength`, `minOccurrences` must be positive integers.
  - `padStart`/`padEnd`/`padBoth` throw `RangeError` when the fill would merge into neighbouring graphemes (combining marks, lone flag halves); `mask` rejects a glyph that starts with a combining mark. `readingTime`/`speakingTime` reject non-finite rates.
  - **Changed:** `str().includes`, `startsWith`, `endsWith`, and `replaceAll` are literal and grapheme-aligned like the rest of the package (`str('é').includes('e')` is `false` in decomposed form; `$&` stays literal). New `replaceAll(text, search, replacement)` in `/edit`.
  - Native grapheme lookups segment a growing prefix of the text instead of all of it (`Intl.Segmenter.segment` copies the whole string per call): `at`/`take` near the start now cost the same on 10k and 100k characters.
  - Fallback scanner: a keycap, tag, or variation selector between an Indic linker and the next consonant no longer joins them (matches `Intl.Segmenter`).
  - **New:** Spanish and German readability. `syllableCount(text, { language: 'es' | 'de' })`, `fernandezHuerta`, `szigrisztPazos`, `fleschAmstad`, `wienerSachtextformel` in `/readability`.
  - **New:** `keywords(text, { language: 'es' | 'de' | 'fr' | 'ro' })` picks that language's stop words; every list is exported as `STOP_WORDS`.
  - Cross-runtime smoke script (`bun run smoke`: Node, Node without `Intl.Segmenter`, Bun, Deno), a seeded fuzz test of the fallback scanner against `Intl.Segmenter`, and ratio-based performance guards.
  - **New:** `readability(text, { language: 'es' | 'de' })` returns that language's score set; `analyze(text)` (in `/metrics`) is public and every readability, vocabulary and metrics function accepts the analysis in place of the string, so one tokenization serves many scores and custom formulas.
  - **New:** `truncate` and `excerpt` take `boundary: 'sentence'`; `excerpt` also takes `'word'`. Edges snap inward and never cross the match. `truncate` always drops whitespace before the ellipsis.
  - **New:** `fold` in `/unicode` (search-key form: lowercase, marks stripped, `ß`/`ø`/`ł`… spelled out), `/distance` with `levenshtein`, `diceCoefficient`, `jaroWinkler` measured in graphemes, `dedent` in `/format` (function or template tag), `initials(text, { singleWord })`. `str()` gains `fold()` and `dedent()`.
  - **Removed** (no compatibility shims before 1.0): `ENGLISH_STOP_WORDS` (use `STOP_WORDS.en`), the `base64` object (use `toBase64`/`tryFromBase64` with `{ alphabet: 'url' }` for the URL variants), and `countCharacters` with its `/count-characters` subpath (use `length()` for graphemes or native `.length` for UTF-16 units).

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
