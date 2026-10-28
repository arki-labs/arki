# @arki/string for agents

The long form of [llms.txt](../llms.txt). When they disagree, `src/index.ts` wins.

## The model

1. Each concern has its own subpath: `/case`, `/format`, `/slug`, `/base64`, `/readability`, and more. The root `@arki/string` re-exports all of them.
2. Functions are plain and pure. `str(value)` from `/fluent` wraps the same functions in an immutable chain.
3. Lengths and positions count graphemes (what a reader sees). Native `.length` counts UTF-16 units.
4. Encoding failures are canonical values from `@arki/failure`; narrow with `isFailure`. Other static misuse uses `StringError`. Wrong types are not checked.
5. The package depends on `@arki/failure` and runs on Node, Bun, Deno, browsers and Hermes.

## Task map

### Make a URL slug from a title

1. Import `slugify` from `@arki/string/slug`.
2. Pass `{ locale }` when the language is not German. The default maps `ä` to `ae`.
3. For Chinese or Korean, pass `{ replacements: chinese }` from `@arki/string/slug-cjk`.

```ts run
import { slugify } from '@arki/string/slug';

if (slugify('Café Guide & Notes') !== 'cafe-guide-and-notes') throw new Error('slug');
if (slugify('ä ö', { locale: 'sv' }) !== 'a-o') throw new Error('locale');
```

### Cut text to a budget without breaking it

1. Import `truncate` from `@arki/string/format`.
2. The budget includes the ellipsis. Pass `boundary: 'word-before'` to back up to a word.

```ts run
import { truncate } from '@arki/string/format';

const cut = truncate('The quick brown fox', 10, { boundary: 'word-before' });
if (cut !== 'The quick…') throw new Error(cut);
```

### Decode base64 from a user

1. Call `fromBase64` and narrow with `isFailure` before using the text.
2. `InvalidBase64` (`string.invalid_base64`) identifies malformed base64; `InvalidUtf8` (`string.invalid_utf8`) identifies invalid text bytes.
3. Breaking: `tryFromBase64` is removed; use `fromBase64` and replace null checks and catches with failure narrowing. E002/E003 are removed; static misuse retains E001/E004. Fluent codecs also return failures or `StringValue`.

### Fill a template

1. `interpolate('Hi {{ name }}', { name: 'Ada' })`.
2. Narrow the returned `MissingValue` before using the text or fluent wrapper. The default `missing: 'fail'` returns a failure for an absent own key or an undefined value. Choose `'keep'` or `'empty'` only when that recovery is intended.

### Score how hard a text is to read

1. Call `analyze(text)` once from `/metrics`.
2. Pass the result to each readability or vocabulary function.

## Rules that bite

- `length('👨‍👩‍👧‍👦')` is `1`. Native `.length` is `11`. Do not mix them in one calculation.
- `slugify` uses German rules by default: `ü` becomes `ue`.
- `escapeHtml` is not a sanitizer.
- `hashCode` is not cryptographic.
- `interpolate` keys are flat identifiers. `{{ a.b }}` is `ARKI_STRING_E004`.
- `Boolean(str(''))` is `true`. Use `.isEmpty()`.
- Chinese and Korean slugs need `@arki/string/slug-cjk`.
- Encoding functions return failures. Static misuse in other APIs still throws `StringError`.

## Errors

| Code                    | Meaning                                                                | What to do                                                 |
| ----------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------- |
| `ARKI_STRING_E001`      | An argument is out of range: empty needle, negative length, bad glyph. | Check the argument against the reference.                  |
| `string.invalid_utf8`   | Text or bytes are not valid UTF-8.                                     | Pass well-formed text, and handle the returned failure.    |
| `string.invalid_base64` | Input is not strict base64.                                            | Fix padding and alphabet, and handle the returned failure. |
| `ARKI_STRING_E004`      | A placeholder is malformed.                                            | Write `{{ name }}` and close every `{{`.                   |
| `string.missing_value`      | A placeholder has no value and `missing` is `'fail'`.                 | Pass the value, or set `missing`.                          |

## Verify

```sh
bun run test
bun run test:docs
bun ../../tooling/library/src/llms.ts --check
```
