# @arki/assert

Runtime assertion helpers for ARKI — small, typed predicates for common formats. Built on top of [`validator`](https://github.com/validatorjs/validator.js) and [`is-language-code`](https://github.com/sindresorhus/is-language-code).

## Installation

```sh
npm install @arki/assert
# or
bun add @arki/assert
# or
pnpm add @arki/assert
```

## Usage

```ts
import { isURL } from '@arki/assert/url';
import { isBase64 } from '@arki/assert/base64';
import { isLanguageCode } from '@arki/assert/language';

isURL('https://example.com');          // true
isURL('not a url');                    // false

isBase64('SGVsbG8sIFdvcmxkIQ==');      // true
isBase64('not base64');                // false

isLanguageCode('en-US');               // { res: true, ... }
isLanguageCode('not-a-code');          // { res: false, ... }
```

The subpath layout (`@arki/assert/url`, `@arki/assert/base64`, `@arki/assert/language`) keeps each predicate independently importable so bundlers only pull in the validators you actually use.

### `isURL`

Validates HTTP and HTTPS URLs. Requires a valid protocol, host, and TLD; allows underscores and trailing dots.

### `isBase64`

Validates standard (non-URL-safe) base64 strings.

### `isLanguageCode`

Validates BCP-47 language codes (e.g. `en`, `en-US`, `zh-Hant`). Returns the underlying `is-language-code` result object with `res` and `error` fields.

## API

- `@arki/assert/url`
  - `isURL(value: string): boolean`
- `@arki/assert/base64`
  - `isBase64(value: string): boolean`
- `@arki/assert/language`
  - `isLanguageCode(value: string)` — returns the `is-language-code` result.

## Documentation

`@arki/assert` is framework-agnostic and works on its own. When you compose
it with the [`@arki/dot`](https://www.npmjs.com/package/@arki/dot)
application framework, see `packages/dot/docs/` for plugin authoring,
lifecycle, and diagnostics.

## License

MIT — see [LICENSE](./LICENSE).
