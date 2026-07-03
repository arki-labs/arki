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

Peer-installs:

- `drizzle-orm`
- `zod` (v4)
- `zod-form-data`

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

import { createInsertSchema, createSelectSchema } from '@arki/contracts';

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

- `createSelectSchema(table, refine?)` — branded select schema.
- `createInsertSchema(table, refine?)` — branded insert schema.
- `createUpdateSchema(table, refine?)` — every field optional, otherwise like insert.
- `COLUMN_ZOD_SCHEMA` — `Symbol.for('@arki/contracts/columnZodSchema')` side-channel for ID factories.
- `bufferSchema`, `jsonSchema`, `literalSchema`, `createSchemaFactory` — re-exported from `drizzle-orm/zod`.
- `formData` — re-exported `zod-form-data` namespace.
- `z`, `ZodError`, every Zod export — re-exported from `zod/v4`.

## Documentation

`@arki/contracts` is framework-agnostic and works on its own. When you
compose it with the [`@arki/dot`](https://www.npmjs.com/package/@arki/dot)
application framework, see `packages/dot/docs/` for plugin authoring,
lifecycle, and diagnostics.

## License

MIT. See [LICENSE](./LICENSE).
