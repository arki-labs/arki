# @arki/date

Date and time utilities for ARKI — thin wrappers and re-exports over [`date-fns`](https://date-fns.org/) with project-aligned formatters.

## Installation

```sh
npm install @arki/date
# or
bun add @arki/date
# or
pnpm add @arki/date
```

## Usage

### Human-readable formatting

```ts
import { toHumanReadableDate } from '@arki/date/format';

toHumanReadableDate(new Date('2026-05-20'));
// 'May 20, 2026'
```

### Re-exported `date-fns` helpers

```ts
import { format } from '@arki/date/format';
import { parseISO } from '@arki/date/parseISO';

const d = parseISO('2026-05-20T10:00:00Z');
format(d, 'yyyy-MM-dd');
// '2026-05-20'
```

The subpath layout (`@arki/date/format`, `@arki/date/parseISO`) lets bundlers tree-shake unused `date-fns` modules without pulling in the entire library.

## API

- `@arki/date/format`
  - `toHumanReadableDate(date: Date): string` — produce a localized `LLL dd, y` string.
  - `format` — re-export of `date-fns/format`.
- `@arki/date/parseISO`
  - `parseISO` — re-export of `date-fns/parseISO`.

## Documentation

`@arki/date` is framework-agnostic and works on its own. When you compose
it with the [`@arki/dot`](https://www.npmjs.com/package/@arki/dot)
application framework, see `packages/dot/docs/` for plugin authoring,
lifecycle, and diagnostics.

## License

MIT — see [LICENSE](./LICENSE).
