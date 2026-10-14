# @arki/contracts

Shared Zod schemas and Drizzle contract helpers — branded ID-aware select / insert / update schemas with auto-applied column refinements.

## Installation

```sh
npm install @arki/contracts
# or
bun add @arki/contracts
# or
pnpm add @arki/contracts
```

Dependencies: `zod` (v4) and `zod-form-data`.

The `@arki/contracts/drizzle` entry needs `drizzle-orm` (an optional peer dependency). The main entry never loads it.

## Why

`drizzle-zod`'s `createSelectSchema` walks Drizzle's `dataType` strings to infer Zod shapes. That mechanism loses three things:

1. Branded ID types declared via `varchar('id').$type<\`usr\_${string}\`>()`collapse to plain`string`.
2. `jsonb('col').$type<Shape>()` shapes collapse to `unknown`.
3. Runtime validation schemas stashed on a column by an ID-factory side-channel are not applied automatically.

`@arki/contracts` wraps `drizzle-zod`'s factories so the output schema preserves the branded type _and_ auto-applies any column-stashed runtime schema, with user-provided refines still winning.

## Usage

### Re-exported Zod surface

```ts
import { z } from '@arki/contracts';

const Email = z.email();
```

The package re-exports everything from `zod/v4`, so you do not need a direct `zod` import alongside it.

### Form data helpers

```ts
import { formData } from '@arki/contracts';

const schema = formData.zfd.formData({
  name: formData.zfd.text(),
  age: formData.zfd.numeric(),
});
```

### Branded select / insert / update schemas

```ts
import { jsonb, pgTable, varchar } from 'drizzle-orm/pg-core';

import { createInsertSchema, createSelectSchema } from '@arki/contracts/drizzle';

const users = pgTable('users', {
  id: varchar('id').$type<`usr_${string}`>().primaryKey(),
  email: varchar('email').notNull(),
  profile: jsonb('profile').$type<{ displayName: string }>(),
});

const userSelect = createSelectSchema(users);
type User = z.infer<typeof userSelect>;
// { id: `usr_${string}`; email: string; profile: { displayName: string } | null }
```

If an ID-factory stashed a Zod schema on a column via `COLUMN_ZOD_SCHEMA`, parsing rejects values with the wrong prefix:

```ts
userSelect.parse({ id: 'org_42', email: 'a@example.com', profile: null });
// throws: id must start with "usr_"
```

User-provided refines override the auto-applied schema:

```ts
const strictSelect = createSelectSchema(users, {
  email: schema => schema.email(),
});
```

## API

Main entry, `@arki/contracts` (no Drizzle):

- `formData` — re-exported `zod-form-data` namespace.
- `z`, `ZodError`, every Zod export — re-exported from `zod/v4`.
- `UserId`, `userIdSchema` — shared id types.

Drizzle entry, `@arki/contracts/drizzle`:

- `createSelectSchema(table, refine?)` — branded select schema.
- `createInsertSchema(table, refine?)` — branded insert schema.
- `createUpdateSchema(table, refine?)` — every field optional, otherwise like insert.
- `COLUMN_ZOD_SCHEMA` — `Symbol.for('@arki/contracts/columnZodSchema')` side-channel for ID factories.
- `bufferSchema`, `jsonSchema`, `literalSchema`, `createSchemaFactory` — re-exported from `drizzle-orm/zod`.

## Documentation

`@arki/contracts` is framework-agnostic and works on its own. When you
compose it with the [`@arki/dot`](https://www.npmjs.com/package/@arki/dot)
application framework, see `packages/dot/docs/` for plugin authoring,
lifecycle, and diagnostics.

<!-- bench:start -->
## Benchmarks

Building and using Zod schemas from a 15-column Drizzle table, compared with drizzle-orm/zod (which @arki/contracts wraps) and a hand-written Zod object.

Node v22.13.1 on Apple M2 Max, 2026-10-13. Median time per operation, lower is better.

### Build select schema (15 columns)

Usually done once at startup.

| Library | Time / op | vs fastest |
| --- | ---: | ---: |
| @arki/contracts createSelectSchema | 193.66 µs | 1.26× |
| drizzle-orm/zod createSelectSchema | 153.73 µs | fastest |

### Build insert schema (15 columns)

| Library | Time / op | vs fastest |
| --- | ---: | ---: |
| @arki/contracts createInsertSchema | 148.37 µs | 1.60× |
| drizzle-orm/zod createInsertSchema | 92.97 µs | fastest |

### Parse one valid row

@arki/contracts and the hand-written schema check the id prefix "usr_"; plain drizzle-orm/zod only checks that id is a string.

| Library | Time / op | vs fastest |
| --- | ---: | ---: |
| @arki/contracts select schema | 2.71 µs | 3.43× |
| drizzle-orm/zod select schema | 2.82 µs | 3.57× |
| hand-written z.object | 790.4 ns | fastest |

Read the rows with the contracts in mind:

- @arki/contracts calls drizzle-orm/zod and then adds branded types and the per-column runtime schemas stashed by ID factories; that extra work is the cost shown in the build rows.
- The hand-written schema does not read the table at all, so it only shows the floor for parsing.

Reproduce with `bun run bench` in the package directory; regenerate this section with `bun run bench --write-readme`.
<!-- bench:end -->

## License

MIT. See [LICENSE](./LICENSE).
