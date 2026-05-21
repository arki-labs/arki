# @arki/slugify

URL-safe slug generation with multi-language transliteration rules. Built on top of [`@sindresorhus/slugify`](https://github.com/sindresorhus/slugify) and extended with curated rule sets for 20+ scripts.

## Installation

```sh
npm install @arki/slugify
# or
bun add @arki/slugify
# or
pnpm add @arki/slugify
```

## Usage

```ts
import { slugify } from '@arki/slugify';

slugify('Hello World');
// 'hello-world'

slugify('Привет мир');
// 'privet-mir'

slugify('Ä ä Ö ö Ü ü ẞ ß');
// 'ae-ae-oe-oe-ue-ue-ss-ss'

slugify('°¹²³⁴⁵⁶⁷⁸⁹@₀₁₂₃₄₅₆₇₈₉');
// '0123456789at0123456789'
```

The slugifier composes language-specific transliteration tables — Arabic, Armenian, Azerbaijani, Burmese, Czech, Finnish, Georgian, German, Greek, Hindi, Latvian, Norwegian, Polish, Romanian, Russian, Slovak, Turkish, Ukrainian, Vietnamese, Yiddish — so non-ASCII input collapses to readable ASCII slugs without losing meaning.

## API

- `slugify(input: string): string` — produce a URL-safe slug from an arbitrary input string.

## Documentation

`@arki/slugify` is framework-agnostic and works on its own. When you
compose it with the [`@arki/dot`](https://www.npmjs.com/package/@arki/dot)
application framework, see `packages/dot/docs/` for plugin authoring,
lifecycle, and diagnostics.

## License

MIT — see [LICENSE](./LICENSE).
