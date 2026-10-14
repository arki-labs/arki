# @arki/assert

Runtime assertion helpers for ARKI — small, typed predicates for common formats. Built on top of [`validator`](https://github.com/validatorjs/validator.js).

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
import { isBase64 } from '@arki/assert/base64';
import { isURL } from '@arki/assert/url';

isURL('https://example.com'); // true
isURL('not a url'); // false

isBase64('SGVsbG8sIFdvcmxkIQ=='); // true
isBase64('not base64'); // false
```

The subpath layout (`@arki/assert/url`, `@arki/assert/base64`) keeps each predicate independently importable so bundlers only pull in the validators you actually use.

### `isURL`

Validates HTTP and HTTPS URLs. Requires a valid protocol, host, and TLD; allows underscores and trailing dots.

### `isBase64`

Validates standard (non-URL-safe) base64 strings.

## API

- `@arki/assert/url`
  - `isURL(value: string): boolean`
- `@arki/assert/base64`
  - `isBase64(value: string): boolean`

## Errors

`isURL` and `isBase64` return `false` for any string they reject and never throw for a string. A value that is not a string is a programming error: `isBase64(42)` throws the built-in `TypeError`. This package defines no error codes.

## Runtime support

Pure ESM, no `node:*` imports. The predicates use only string methods and one precompiled regular expression, so they run on Node, Bun, Deno, browsers and React Native (Hermes). `bun run test:runtimes` runs a smoke test of the built package on each runtime; the Hermes leg needs `HERMES_BIN` and prints `INCOMPLETE` when it is missing.

## Documentation

`@arki/assert` is framework-agnostic and works on its own. When you compose
it with the [`@arki/dot`](https://www.npmjs.com/package/@arki/dot)
application framework, see `packages/dot/docs/` for plugin authoring,
lifecycle, and diagnostics.

<!-- bench:start -->

## Benchmarks

Compares the @arki/assert predicates with the library they are built on (validator, used directly with the same options) and with checks the platform already ships. Each call checks one valid and one invalid input.

Node v22.13.1 on Apple M2 Max, 2026-10-13. Median time per operation, lower is better.

### Is this an http(s) URL?

| Library                                | Time / op | vs fastest |
| -------------------------------------- | --------: | ---------: |
| @arki/assert isURL                     |   4.70 µs |     28.14× |
| validator isURL (same options, direct) |   2.66 µs |     15.91× |
| native URL.canParse                    |  167.1 ns |    fastest |

### Is this a base64 string?

| Library                                   | Time / op | vs fastest |
| ----------------------------------------- | --------: | ---------: |
| @arki/assert isBase64                     |  305.5 ns |    fastest |
| validator isBase64 (same options, direct) |  481.7 ns |      1.58× |
| native regex (precompiled)                |  425.8 ns |      1.39× |
| native atob in try/catch (lenient)        |  17.19 µs |     56.26× |

Read the rows with the contracts in mind:

- `isURL` and `isBase64` in @arki/assert call validator with fixed options. The "validator directly" rows show what the wrapper adds, which is one extra function call.
- `URL.canParse` follows the WHATWG URL standard. It accepts any scheme (`mailto:`, `ftp:`, `javascript:`), does not need a top-level domain, and normalises odd input. The @arki/assert check accepts only http and https URLs that have a protocol, a host and a TLD. It is stricter, so the rows do not accept the same set of strings.
- The native base64 regex checks strict, padded, standard-alphabet base64. `atob` is lenient: it accepts missing padding and ignores whitespace. validator and @arki/assert accept standard base64 with padding rules of their own.

Reproduce with `bun run bench` in the package directory; regenerate this section with `bun run bench --write-readme`.
<!-- bench:end -->

## License

MIT — see [LICENSE](./LICENSE).
