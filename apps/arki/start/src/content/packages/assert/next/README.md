# @arki/assert

Two typed string checks, `isURL` and `isBase64`, built on [`validator`](https://github.com/validatorjs/validator.js). Each lives on its own subpath, so a bundler keeps only the one you import.

## Install

```sh
bun add @arki/assert
# or
npm install @arki/assert
```

## Quick start

Check a callback URL and a signing secret before you save a webhook.

```ts run
import { isBase64 } from '@arki/assert/base64';
import { isURL } from '@arki/assert/url';

const checks = [
  isURL('https://example.com/hooks'), // true: an http(s) URL with a domain
  isURL('example.com'), // false: no protocol
  isBase64('c2VjcmV0LWtleQ=='), // true: standard base64, padded
  isBase64('not base64!'), // false
];
if (checks.join() !== 'true,false,true,false') throw new Error(`unexpected results: ${checks.join()}`);
```

The same checks inside a form validator. The file is `examples/validate-webhook-settings.ts`, and a test runs it.

```ts from="examples/validate-webhook-settings.ts#validate-webhook"
export type WebhookSettings = { callbackUrl: string; signingSecret: string };

/** Returns one message per bad field. An empty list means the form can be saved. */
export function validateWebhookSettings(input: WebhookSettings): string[] {
  const problems: string[] = [];
  if (!isURL(input.callbackUrl)) problems.push('callbackUrl: use an http(s) URL with a domain');
  if (input.signingSecret === '' || !isBase64(input.signingSecret)) {
    problems.push('signingSecret: paste the base64 secret from your provider');
  }
  return problems;
}
```

## When not to use this

- You need to parse a URL. Use the platform `URL` class. `isURL` only answers yes or no.
- You accept `mailto:`, `ftp:`, custom schemes or `localhost`. `isURL` rejects them. Use `URL.canParse` and check the protocol yourself.
- You need URL-safe base64 (`-` and `_`). `isBase64` rejects it.
- You need a schema for a whole object. Use a schema library and call these checks inside it.

## Runtime support

Pure ESM with no `node:*` imports. The checks use string methods and one precompiled regular expression, so they run on Node, Bun, Deno, browsers and React Native (Hermes). `bun run test:runtimes` runs a smoke test of the built package on each runtime. The Hermes leg needs `HERMES_BIN` and prints `INCOMPLETE` when it is missing.

<!-- runtimes:start -->

| Runtime | Result  | Version tested        | Date (UTC) |
| ------- | ------- | --------------------- | ---------- |
| node    | pass    | v26.11.1              | 2026-10-17 |
| bun     | pass    | 1.4.2                 | 2026-10-17 |
| deno    | pass    | 2.9.7                 | 2026-10-17 |
| browser | pass    | Chromium 156.0.8078.4 | 2026-10-17 |
| hermes  | not run | -                     | 2026-10-17 |

<!-- runtimes:end -->

## Public imports

| Import                | Exports                            |
| --------------------- | ---------------------------------- |
| `@arki/assert/url`    | `isURL(value: string): boolean`    |
| `@arki/assert/base64` | `isBase64(value: string): boolean` |

There is no root import. `@arki/assert` alone does not resolve.

## Failure behaviour

A string the check rejects returns `false`. A string never makes either function throw. Branch on the returned boolean.

A value that is not a string is a programming error. `isBase64(42)` throws the built-in `TypeError`. TypeScript rejects that call at compile time, so it only happens when data crosses an untyped boundary such as `JSON.parse`. Validate the type there first. The package defines no error codes.

## Limits

- `isURL` accepts `http` and `https` only, and needs a protocol, a host and a top-level domain. `http://localhost` is `false`; `http://localhost.localdomain.com` is `true`.
- `isBase64` accepts the standard alphabet with `=` padding. The length must be a multiple of 4. `isBase64('Zm9v')` is `true`; `isBase64('Zm9')` is `false`.
- `isBase64('')` is `true`, because an empty string is valid base64. Reject the empty value yourself when you need content.
- Neither check trims. `isURL(' https://example.com')` is `false`.
- `isURL` is a syntax check. It does not resolve the host or send a request.

## Documentation

- [Agent guide](./docs/agent-guide.md): tasks, rules that bite, errors.
- [llms.txt](./llms.txt): the index an agent reads first.
- [Changelog](./CHANGELOG.md).

## Support

Report a bug or ask a question at [github.com/arki-labs/arki/issues](https://github.com/arki-labs/arki/issues). Include the input string and the result you expected.

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
