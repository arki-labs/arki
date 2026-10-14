---
'@arki/contracts': minor
---

Importing `@arki/contracts` no longer loads Drizzle. Breaking: everything that needs `drizzle-orm` moved to a new `@arki/contracts/drizzle` entry: `createSelectSchema`, `createInsertSchema`, `createUpdateSchema`, `COLUMN_ZOD_SCHEMA`, `bufferSchema`, `jsonSchema`, `literalSchema` and `createSchemaFactory`. The main entry keeps `z` (all of `zod/v4`), `formData` and the shared id types, and now runs the same on every runtime. The `./schema` entry and the `browser` export condition are gone. `drizzle-orm` is now an optional peer dependency. To upgrade, import the table schema helpers from `@arki/contracts/drizzle` and change `@arki/contracts/schema` to `@arki/contracts`.
