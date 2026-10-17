# @arki/doc-package

A fixture for `arki-doc-examples`. The second block is correct. Every other block breaks one rule, in rule order: E004 first, because only the first block of a file can lack a previous one.

```ts continue
greet('nobody before me');
```

```ts
import { greet } from '@arki/doc-package';
import { connect } from '@arki/doc-package/pg';

export const line = `${greet('Ada')} via ${connect('postgres://localhost/app').url}`;
```

DOCX_E001: a wrong call.

```ts
import { greet } from '@arki/doc-package';

greet(42);
```

DOCX_E002: a run block whose outcome is wrong.

```ts run
throw new Error('the outcome was wrong');
```

DOCX_E003: a skip with no reason.

```ts skip
greet();
```

DOCX_E005: an unknown fence word.

```ts title="app.ts"
export const title = 'app';
```

DOCX_E006: an `any`.

```ts
const loose: any = 1;
export { loose };
```

DOCX_E007: a package the manifest does not declare, even though it resolves from the root `node_modules`.

```ts
import { z } from 'zod';

export const schema = z.string();
```

## Install

Add `@arki/doc-package` with your package manager.

## Quick start

Call `greet` with a name.

## When not to use this

When you need more than a greeting.

## Runtime support

Node, Bun, Deno and the browser.

## Public imports

`@arki/doc-package` and `@arki/doc-package/pg`.

## Failure behaviour

Nothing throws.

## Limits

None.

## Documentation

See `docs/agent-guide.md`.

## Support

Open an issue.
