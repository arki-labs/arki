# Drizzle 1.0 RQBv2 — Migration Notes & Design Decisions

This document captures everything learned while migrating the workspace from
`drizzle-orm@0.x` to `drizzle-orm@1.0.0-rc.1` (RQBv2). Read this before
touching another v0 → v1 backend or extending the schema-builder layer.

## Table of contents

1. [What changed in Drizzle 1.0](#what-changed-in-drizzle-10)
2. [Per-app `relations.ts` (the new RQBv2 graph)](#per-app-relationsts-the-new-rqbv2-graph)
3. [Querying — the structured filter language](#querying--the-structured-filter-language)
4. [When `RAW` is the right answer](#when-raw-is-the-right-answer)
5. [Brand-preserving `createSelectSchema` wrapper](#brand-preserving-createselectschema-wrapper)
6. [Runtime brand validation via column tagging](#runtime-brand-validation-via-column-tagging)
7. [Per-backend migration playbook](#per-backend-migration-playbook)
8. [Known traps](#known-traps)
9. [Files / ID factory contracts](#files--id-factory-contracts)

---

## What changed in Drizzle 1.0

Three breaking shifts shaped the migration:

1. **RQBv1 `relations(table, ({ one, many }) => ({...}))` was removed.** Replaced by
   a single per-app `defineRelations(tables, (r) => ({...}))` call that owns the
   entire relation graph.
2. **`db.query.X.findFirst/findMany` no longer accepts raw `SQL` for `where`/`orderBy`.**
   The v0 form `where: eq(t.x, v)` now needs the structured filter object
   `where: { x: v }`, OR the explicit escape hatch `where: { RAW: eq(t.x, v) }`.
3. **`drizzle-zod`'s `createSelectSchema` walks runtime `dataType` strings.** The
   `column._.data` phantom (where `$type<>()` brands live) is no longer read,
   so jsonb `$type<MyShape>()` collapses to `Json` and varchar branded IDs
   widen to `string`.

Everything below is a consequence of those three shifts.

---

## Per-app `relations.ts` (the new RQBv2 graph)

Every backend exports a single `src/relations.ts`:

```ts
import { defineRelations } from '@arki/db/orm';
import { Account, User } from './features/auth/tables';
import { Document } from './features/documents/tables';

const tables = { Account, Document, User };

export const relations = defineRelations(tables, (r) => ({
  User: {
    accounts: r.many.Account({ from: r.User.id, to: r.Account.userId }),
    documents: r.many.Document({ from: r.User.id, to: r.Document.userId }),
  },
  Account: {
    user: r.one.User({ from: r.Account.userId, to: r.User.id }),
  },
  Document: {
    owner: r.one.User({ from: r.Document.userId, to: r.User.id }),
  },
}));
```

Then `db.ts` wires it in:

```ts
import { createDb } from '@arki/db/factory';
import { relations } from './relations';

export const db = createDb({ relations });
export type Relations = typeof relations;
```

Backends using the projection-aware builder (`@arki/db/builder`) use
`initDb.relations(relations).create(...)` instead of `.schema(schema)`.

### Aliases are GLOBAL across the relations object

If any two relations share a `(fromTable, toTable)` pair OR a self-reference,
**both sides need the same `alias`**. Aliases live in a global namespace —
collisions across unrelated tables silently break the graph. Convention:

> **Prefix every alias with its owning table name.**

```ts
comments: {
  creator:   r.one.User({ from: ..., to: ..., alias: 'comment_creator' }),
  moderator: r.one.User({ from: ..., to: ..., alias: 'comment_moderator' }),
  parent:    r.one.comments({ from: ..., to: ..., alias: 'comment_parent', optional: true }),
  replies:   r.many.comments({ from: ..., to: ..., alias: 'comment_parent' }),
},
```

`'creator'` alone is a footgun — it'll clash with `claims.creator`,
`reviews.creator`, etc.

### 1:1 relations need a unique target column

For an `r.one.X({ from: A.fkCol, to: B.col })` relation, `B.col` must be the
PK or have a `.unique()` constraint. v0 silently allowed non-unique targets;
v1 enforces it. If the column isn't already unique, add `.unique()` in the
table definition (kapodopera example: `UserProfile.userId.unique()` so
`UserFollow.followerId → UserProfile.userId` compiles).

### Composite-key relations use tuple `from`/`to`

```ts
contentProgress: {
  bookState: r.one.bookProgressStates({
    from: [r.contentProgress.userId, r.contentProgress.creativeWorkId, r.contentProgress.firstEngagedAt],
    to:   [r.bookProgressStates.userId, r.bookProgressStates.creativeWorkId, r.bookProgressStates.firstEngagedAt],
    optional: true,
  }),
},
```

### Polymorphic relations stay in app code

A column pair like `targetType: 'review' | 'comment'; targetId: string` can't
be modeled by `r.one`/`r.many` — RQBv2 doesn't have polymorphic discrimination.
Resolve it in the repository layer with a switch on `targetType`. (Reactions,
moderation reports, location associations all use this pattern.)

---

## Querying — the structured filter language

RQBv2 replaces v1's `where: <SQL>` with a structured filter object. Reference
table for the most common transforms:

| v0 (RQBv1) | v1 (RQBv2 structured) |
| --- | --- |
| `where: eq(t.id, x)` | `where: { id: x }` |
| `where: (t, { eq }) => eq(t.x, v)` | `where: { x: v }` |
| `where: and(eq(t.a, v), eq(t.b, w))` | `where: { a: v, b: w }` |
| `where: or(eq(t.a, v), eq(t.b, w))` | `where: { OR: [{ a: v }, { b: w }] }` |
| `where: inArray(t.col, ids)` | `where: { col: { in: ids } }` |
| `where: like(t.name, p)` | `where: { name: { like: p } }` |
| `where: ilike(t.name, p)` | `where: { name: { ilike: p } }` |
| `where: gt(t.x, n)` | `where: { x: { gt: n } }` |
| `where: gte(t.x, a) AND lte(t.x, b)` | `where: { x: { gte: a, lte: b } }` |
| `where: isNotNull(t.x)` | `where: { x: { isNotNull: true } }` (literal `true`) |
| `where: not(eq(t.x, v))` | `where: { x: { ne: v } }` or `{ NOT: { x: v } }` |
| `orderBy: column` | `orderBy: (t) => t.column` |
| `orderBy: [a, b]` | `orderBy: (t) => [t.a, t.b]` |
| `orderBy: desc(t.x)` | `orderBy: (t, { desc }) => desc(t.x)` |
| imperative `conditions.push(...)` | inline spread `...(maybeVal && { col: maybeVal })` |

### Imperative builder → object spread

```ts
// before
const conditions = [eq(Foo.x, x)];
if (y) conditions.push(eq(Foo.y, y));
if (zList) conditions.push(inArray(Foo.z, zList));
where: { RAW: and(...conditions)! }

// after
where: {
  x,
  ...(y && { y }),
  ...(zList && { z: { in: zList } }),
}
```

### Relation-filter joins

When a relation already exists in `src/relations.ts`, filter through it instead
of writing raw `EXISTS`:

```ts
where: { user: { name: { ilike: '%foo%' } } }
```

### `isNull`/`isNotNull` need literal `true`

`{ col: { isNull: true } }` — NOT `boolean`. RQBv2's type signature is
`isNull?: true | undefined` because `isNull: false` would be ambiguous
("not null" vs "ignore"). If TypeScript widens, use `isNull: true as const`.

---

## When `RAW` is the right answer

`{ RAW: <SQL> }` is the escape hatch. Coexists with structured keys in the same
filter (they're AND'd at the top level):

```ts
where: {
  status: 'active',
  RAW: sql`${Foo.amount}::float >= ${minVal}`,
}
```

Use `RAW` only for things with no structured equivalent:

| Case | Why structured doesn't work |
| --- | --- |
| `sql\`${col}::float >= ${val}\`` | Type casts |
| `sql\`${col} @> ${json}\`` | JSONB containment |
| `sql\`EXISTS (SELECT 1 FROM ... WHERE ...)\`` | Subqueries that don't traverse a relation |
| `sql\`${col} > NOW() - INTERVAL '7 days'\`` | INTERVAL arithmetic |
| Full-text search (`@@`) | No operator equivalent |
| `id IN (SELECT ...)` true subqueries | No structured form |

Across all 18 backends after migration, only ~7 RAW sites remain — all
legitimately raw.

---

## Brand-preserving `createSelectSchema` wrapper

`@arki/contracts` ships a wrapper around drizzle-zod's
`createSelectSchema`/`createInsertSchema`/`createUpdateSchema` that recovers
the brand and JSON shape information drizzle-zod 1.0 drops.

### Why drizzle-zod 1.0 erases brands

Looking at the runtime path:

- `column-builder.js`: `$type<T>() { return this; }` — `$type` is a phantom; the
  generic `T` is never stored at runtime.
- `zod/column.js`: `extractExtendedColumnType(column)` reads `column.dataType`
  (a string like `"object json"` or `"string"`) and key-types off that, NOT off
  the `column._.data` phantom field.
- Result: `jsonb('m').$type<Shape>()` → `z.ZodType<Json>` (loses `Shape`),
  `varchar('id').$type<\`p_\${string}\`>()` → `z.ZodString` (loses brand).

This is a **deliberate** v0 → v1 change for two reasons:
1. v0's deeply nested conditional types stalled tsserver on wide tables.
2. Phantom brands can't be runtime-validated, so the runtime schema
   pretending to validate them was never correct.

### How the wrapper restores brands

Located at `packages/contracts/src/schema.ts`. Strategy: keep the runtime
schema unchanged, sharpen the inferred TypeScript output by sourcing it from
`InferSelectModel<TTable>` (which DOES walk the `_.data` phantom).

```ts
// type-only mapping
type StrongShape<TInferred> = {
  [K in keyof TInferred]-?: undefined extends TInferred[K]
    ? z.ZodOptional<z.ZodType<Exclude<TInferred[K], undefined>, Exclude<TInferred[K], undefined>>>
    : z.ZodType<TInferred[K], TInferred[K]>;
};

type StrongSchema<TInferred> = z.ZodObject<StrongShape<TInferred>, z.core.$strip>;
```

#### Two non-obvious subtleties

1. **`-?` strips the optional modifier from each source key.** Without it,
   ZodObject sees `Shape['b']` as `ZodType<...> | undefined` and Zod's
   `$InferObjectOutput` falls into the `string extends keyof T` branch which
   collapses every per-key type to `unknown`.
2. **For source keys whose value type includes `undefined`, wrap inner ZodType
   in `ZodOptional`.** Otherwise the parsed value would forbid missing keys
   that the source model says are optional.

Either fix alone fails — only the combination produces correct inference for
both `.parse()` output AND chain operations like `.pick()`/`.partial()`/`.extend()`.

### What this enables

```ts
const planSelectSchema = createSelectSchema(plans);
// z.infer<typeof planSelectSchema> = {
//   id: `pln_${string}`;       // not string
//   metadata: MyShape | null;  // not Json | null
//   features: string[];        // not Json
//   ...
// }
```

`.output(planSelectSchema)` on tRPC/oRPC procedures now matches the actual
repo return without any per-table override.

---

## Runtime brand validation via column tagging

The wrapper above gives types. Runtime brand checking (`'wrong_xyz'` should be
rejected, not silently accepted) is layered on top via a producer/consumer
side-channel.

### The mechanism (3 moving parts)

1. **Side-channel symbol.** `@arki/contracts` exports
   `COLUMN_ZOD_SCHEMA = Symbol.for('@arki/contracts/columnZodSchema')`.
   `Symbol.for` keeps it global-registry safe across module copies.
2. **Producer tags the column.** `@arki/db`'s `createIdFactory` writes its
   schema to `builder.config[COLUMN_ZOD_SCHEMA]` for every column it produces
   (`primaryColumn`, `foreignKey`, `optionalForeignKey`, `requiredColumn`,
   `optionalColumn`, `reference`, `optionalReference`).
3. **Consumer auto-applies.** `@arki/contracts`' wrappers walk
   `getColumns(table)`, read each column's tagged schema, and merge it into
   the refine map as a CALLBACK refine `(_) => schema`.

### Why builder/column shared config works

```ts
// drizzle's pg-core/columns/varchar.js
class PgVarcharBuilder {
  build(table) { return new PgVarchar(table, this.config); }  // ← same ref
}
class Column {
  constructor(table, config) { this.config = config; }
}
```

The builder's `config` object is the SAME reference passed to the constructed
column. Whatever the factory writes on the builder appears on the column too —
no registry, no WeakMap, no lookup table needed.

### Why CALLBACK form is required

drizzle-zod's `HandleRefinement<TType, TRefine, TColumn>`:

```ts
TRefine extends ((schema: any) => z.ZodType)
  ? (TColumn['_']['notNull'] extends true
      ? ReturnType<TRefine>
      : z.ZodNullable<ReturnType<TRefine>>)
  : TRefine
```

Only callback-form refinements get wrapped in `ZodNullable` for nullable
columns. A bare-schema refinement bypasses the wrap and would refuse `null`
for nullable foreign keys at runtime — silent breakage for a `users.parent_id`
column. Hence `(_) => factory.schema` instead of `factory.schema`.

### Verified behavior

| Case | Result |
| --- | --- |
| `parse({ id: 'pln_abc' })` | OK |
| `parse({ id: 'wrong_xyz' })` | Throws "must start with 'pln_'" |
| `parse({ id: 123 })` | Throws "expected string, received number" |
| `parse({ parentId: null })` for nullable FK | OK |
| `parse({ })` for optional FK on insert | OK (key absent allowed) |
| User passes `refine: { id: customSchema }` | User refine wins |

---

## Per-backend migration playbook

Tested across 18 backends. Steps in order:

### Schema layer

1. **Build `src/relations.ts`** via `defineRelations(tables, (r) => ({...}))`.
   Cover every table + every relation pair (both directions).
2. **Strip v1 `relations()` blocks** from every `tables.ts`. Drop the
   `relations` import from `drizzle-orm`/`@arki/db/orm`. Delete co-located
   `relations.ts` files.
3. **Update `db.ts`**: `createDb({ relations })` (or
   `initDb.relations(relations).create(...)` for builder backends). Add
   `Relations = typeof relations`. Update
   `DrizzleProjectionHandlerContext<Schema>` → `DrizzleProjectionHandlerContext<Relations>`.
4. **Drop `*Relations` exports** from feature `index.ts` barrels.
5. **Add `.unique()`** to any column that's a 1:1 relation target but isn't
   already unique.

### Consumer layer (`db.query.*.findFirst/findMany`)

6. **Sweep every call site** through the structured-filter table above. RAW
   only for cases with no structured equivalent.
7. **Watch for the codemod `}` placement bug.** Some prior automated codemods
   left `eq(...) },` instead of `eq(...),` plus `) },` on `and()`/`or()`
   wrappers. Mechanical fix: drop the inner `},`, walk forward to the matching
   `)` of the wrapping call, append ` }`.

### Verify

8. `bun run typecheck` should hit 0 errors. Most remaining errors after sweep
   are `TS2339`/`TS2551` from joined relations being typed nullable; either
   add `with: { relName: { required: true } }` (when FK is `notNull`) or guard
   with `if (row.rel) { ... }` at the call site.

---

## Known traps

### `drizzle-zod` regression on `createSelectSchema`

If you DON'T use `@arki/contracts`' wrapper, `createSelectSchema` will:
- widen branded `\`prefix_${string}\`` IDs to plain `string`
- drop `jsonb('col').$type<MyShape>()` columns from the inferred shape entirely

Always import from `@arki/contracts`, never directly from `drizzle-orm/zod`.

### Drizzle's `Simplify<T> = { [K in keyof T]: T[K] } & {}`

The `& {}` intersection makes TypeScript treat the result as if `string extends
keyof T`, which collapses Zod's `$InferObjectOutput` per-key types to `unknown`.
The wrapper handles this via the `-?` + `ZodOptional` mapping above. If you're
building your own type-level transforms over `InferInsertModel`/`InferSelectModel`,
expect to apply the same trick.

### `getTableColumns` is deprecated

Use `getColumns` from `drizzle-orm`. Same signature, future-proof.

### Two TS exports can bind to one SQL table

kapodopera has `_shared/series.series` and `literature/series.Series` — both
`schema.table('series', ...)`. They produce different TS objects from the
same SQL row. `defineRelations` keys off TS object identity, so register only
ONE in the relations map (whichever the relation graph traverses).

### Async projection handler context type changed

`DrizzleProjectionHandlerContext<TSchema>` parameterizes on the relations
object now (Drizzle 1.0's `NodePgDatabase<Relations>` signature), NOT on the
legacy schema map. Use `DrizzleProjectionHandlerContext<Relations>`.

### Module init order with self-referencing tables

If you have `contracts.ts` calling `createSelectSchema(plans)` AND `tables.ts`
imports `contracts.ts` indirectly (e.g., through types), Bun/Node may throw
`ReferenceError: Cannot access 'plans' before initialization` at module load.
Restructure to either:
- Import `plans` directly without going through the barrel, OR
- Move `createSelectSchema` calls into a separate module that consumers import
  lazily.

---

## Files / ID factory contracts

### `packages/db/src/id-factory.ts`

`createIdFactory<TPrefix, TId>(prefix)` returns a factory with:

- `create()` / `make()` / `new()` — generate a new prefixed ID
- `schema` — Zod schema validating prefix + branding to `TId`
- `primaryColumn(name?)` — `varchar(256).notNull().primaryKey().$type<TId>().$defaultFn(...)`
- `optionalColumn(name)`, `requiredColumn(name)` — typed varchar columns
- `reference(name)`, `optionalReference(name)` — FK columns without constraint
- `foreignKey(name, refFn, opts?)`, `optionalForeignKey(name, refFn, opts?)` — FK with constraint
- `createForeignKeyFactory(refFn)` — bound factory returning `.required(name)` / `.optional(name)`

**Every column-producing method tags the column with the schema** via
`COLUMN_ZOD_SCHEMA`, so `@arki/contracts`' wrappers auto-apply runtime
brand validation. No per-table refines needed.

### `packages/contracts/src/schema.ts`

Exports:
- `createSelectSchema(table, refine?)` — strong types + auto refine
- `createInsertSchema(table, refine?)` — strong types + auto refine
- `createUpdateSchema(table, refine?)` — strong types + auto refine
- `COLUMN_ZOD_SCHEMA` — symbol for tagging columns from other producers
- Re-exports `bufferSchema`, `createSchemaFactory`, `jsonSchema`,
  `literalSchema` from `drizzle-orm/zod`
- Re-exports `formData` from `zod-form-data`
- Re-exports everything from `zod/v4`

User-provided refines win over auto-derived ones — explicit overrides on a
specific column always take priority.

---

## Migration commit history (kapodopera, the most thorough reference)

| Commit | What it did |
| --- | --- |
| `7a48e7e3f` | Build central `relations.ts`, switch `db.ts` to `initDb.relations(...)`, add `.unique()` to `UserProfile.userId` |
| `d5387b489` | Strip v1 `relations()` blocks from 64 tables.ts files, delete 10 co-located relations.ts files, clean schema.ts barrel |
| `0c4d8d019`–`2c11d2a1d` | RQBv2 sweep across 8 commits — convert ~325 `where:` callsites and ~131 `orderBy:` callsites |
| `afffb029c`–`5bf8b26ef` | RAW → structured filters across 7 commits (163 → 7 RAW usages) |
| `d20943369` | Locations as canonical structured-filter reference + drizzle-zod overrides for payments contracts |
| `c9f1d7a3c` | First brand-preserving wrapper in `@arki/contracts` |
| `b0bccaa87` | Runtime brand validation via column tagging |

Read these in order if you need to recreate the migration on a fresh fork.
