# @arki/assert for agents

The long form of [llms.txt](../llms.txt). When they disagree, `src/url.ts` and `src/base64.ts` win.

## The model

1. The package has two functions: `isURL` from `@arki/assert/url` and `isBase64` from `@arki/assert/base64`.
2. Each takes a string and returns a boolean.
3. There is no root import. `import { isURL } from '@arki/assert'` fails.
4. `isURL` is stricter than `new URL()`. It wants `http` or `https`, a host and a top-level domain.
5. `isBase64` checks the standard alphabet and the padding. It does not decode.

## Task map

### Check a URL a user typed

1. Import `isURL` from `@arki/assert/url`.
2. Call it with the trimmed string.
3. Show your own message when it returns `false`.

```ts run
import { isURL } from '@arki/assert/url';

const typed = 'https://example.com/docs';
if (!isURL(typed)) throw new Error('expected a valid URL');
if (isURL('ftp://example.com')) throw new Error('ftp must be rejected');
```

### Check a base64 secret before you decode it

1. Import `isBase64` from `@arki/assert/base64`.
2. Reject the empty string yourself. `isBase64('')` is `true`.
3. Decode only after the check passes. A failed check means the decoder would read garbage.

```ts run
import { isBase64 } from '@arki/assert/base64';

const secret: string = 'c2VjcmV0LWtleQ==';
if (secret === '' || !isBase64(secret)) throw new Error('expected a base64 secret');
```

### Validate a whole settings form

Collect one message per bad field, then save only when the list is empty. The tested version is `examples/validate-webhook-settings.ts` in the repository.

## Rules that bite

- `isBase64('')` is `true`. Check for an empty value first.
- `isBase64` does not accept URL-safe base64 (`-` and `_`). Convert it first.
- `isBase64(42)` throws `TypeError`. Only strings are valid input, and the type already says so.
- `isURL('example.com')` is `false`: the protocol is required.
- `isURL('http://localhost')` is `false`: a top-level domain is required.
- `isURL` does not trim. Trim user input before you call it.

## Errors

| Code        | Meaning                                          | What to do                                                             |
| ----------- | ------------------------------------------------ | ---------------------------------------------------------------------- |
| none        | The package defines no error codes.              | Both functions return `false` for a bad string. Read the return value. |
| `TypeError` | A value that is not a string reached `isBase64`. | Fix the caller. The TypeScript signature rejects it at compile time.   |

## Verify

```sh
bun run test
bun run test:docs
bun ../../tooling/library/src/llms.ts --check
```
