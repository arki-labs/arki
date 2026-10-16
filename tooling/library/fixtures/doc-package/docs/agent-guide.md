# @arki/doc-package for agents

The long form of [llms.txt](../llms.txt). When they disagree, `dist/index.d.ts` wins.

## The model

1. `greet(name)` returns a greeting. It has no side effects.

## Task map

### Greet someone

```ts run
import { greet } from '@arki/doc-package';

const text = greet('Ada');
```

Then check the outcome:

```ts continue
if (text !== 'Hello, Ada') throw new Error(`unexpected greeting: ${text}`);
```

## Rules that bite

- `greet` takes a name, never a number.

## Errors

| Code | Meaning      | What to do |
| ---- | ------------ | ---------- |
| none | It is total. | Nothing.   |

## Verify

```sh
bun run test:docs
```
