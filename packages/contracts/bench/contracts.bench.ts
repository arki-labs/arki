// Speed of @arki/contracts against drizzle-orm/zod (which it wraps) and a hand-written Zod object.
// Run: `bun run bench` (explore) or `bun run bench --profile publish --write-readme`.
//
// Every `compare` group states a contract and is checked before timing. Parse
// outcomes are reduced to `ok` or `error:<path of the first issue>`. Plain
// drizzle-orm/zod does not check the ID prefix, so it is marked `differs`.

import { boolean, integer, jsonb, pgTable, text, timestamp, varchar } from 'drizzle-orm/pg-core';
import { createInsertSchema as drizzleInsert, createSelectSchema as drizzleSelect } from 'drizzle-orm/zod';
import { z } from 'zod/v4';

import { compare, defineSuite } from '@arki/bench';
import { COLUMN_ZOD_SCHEMA, createInsertSchema, createSelectSchema } from '@arki/contracts/drizzle';

const idColumn = () => {
  const builder = varchar('id', { length: 256 }).notNull().primaryKey();
  // Same stash the ID factories in @arki/db write to; `config` is protected in the types.
  const config: unknown = Reflect.get(builder, 'config');
  if (typeof config === 'object' && config !== null)
    Reflect.set(config, COLUMN_ZOD_SCHEMA, z.string().startsWith('usr_'));
  return builder;
};

const users = pgTable('users', {
  id: idColumn(),
  email: varchar('email', { length: 320 }).notNull(),
  name: text('name').notNull(),
  bio: text('bio'),
  age: integer('age'),
  score: integer('score').notNull(),
  active: boolean('active').notNull(),
  verified: boolean('verified').notNull(),
  role: text('role').notNull(),
  plan: text('plan').notNull(),
  locale: varchar('locale', { length: 16 }).notNull(),
  avatar: text('avatar'),
  profile: jsonb('profile'),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at'),
});

const validRow = {
  id: 'usr_abc123',
  email: 'a@example.com',
  name: 'Ada',
  bio: null,
  age: 36,
  score: 10,
  active: true,
  verified: false,
  role: 'admin',
  plan: 'pro',
  locale: 'en-US',
  avatar: null,
  profile: { a: 1 },
  createdAt: new Date(0),
  updatedAt: null,
};

type Row = Record<string, unknown>;
type Probe = { name: string; row: Row; expected: string };

/** Each invalid row breaks exactly one rule, so the first issue is unambiguous. */
const selectProbes: readonly Probe[] = [
  { name: 'valid', row: validRow, expected: 'ok' },
  { name: 'wrong id prefix', row: { ...validRow, id: 'org_abc123' }, expected: 'error:id' },
  { name: 'email too long', row: { ...validRow, email: 'a'.repeat(321) }, expected: 'error:email' },
  { name: 'null in a required column', row: { ...validRow, name: null }, expected: 'error:name' },
  { name: 'fraction in an integer', row: { ...validRow, score: 1.5 }, expected: 'error:score' },
  { name: 'text for a boolean', row: { ...validRow, active: 'yes' }, expected: 'error:active' },
  { name: 'nullable columns set', row: { ...validRow, bio: 'hi', age: null, updatedAt: new Date(1) }, expected: 'ok' },
  { name: 'integer out of 32-bit range', row: { ...validRow, score: 2 ** 31 }, expected: 'error:score' },
  { name: 'non-JSON value in a jsonb column', row: { ...validRow, profile: new Map() }, expected: 'error:profile' },
];

const requiredOnly: Row = Object.fromEntries(
  Object.entries(validRow).filter(([key]) => !['bio', 'age', 'avatar', 'profile', 'updatedAt'].includes(key)),
);

const insertProbes: readonly Probe[] = [
  { name: 'all columns', row: validRow, expected: 'ok' },
  { name: 'nullable columns left out', row: requiredOnly, expected: 'ok' },
  { name: 'wrong id prefix', row: { ...validRow, id: 'org_abc123' }, expected: 'error:id' },
  { name: 'required column missing', row: { ...requiredOnly, name: undefined }, expected: 'error:name' },
  { name: 'fraction in an integer', row: { ...requiredOnly, score: 2.5 }, expected: 'error:score' },
  { name: 'integer out of 32-bit range', row: { ...requiredOnly, age: 2 ** 31 }, expected: 'error:age' },
  { name: 'non-JSON value in a jsonb column', row: { ...requiredOnly, profile: new Map() }, expected: 'error:profile' },
];

// The same rules the table implies: a Postgres `integer` is 32-bit, and a `jsonb`
// column holds a JSON value (a literal, a plain object or an array), not anything.
const int32 = () => z.number().int().gte(-2_147_483_648).lte(2_147_483_647);
const jsonValue = z.union([
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
  z.record(z.string(), z.any()),
  z.array(z.any()),
]);

const handSelect = () =>
  z.object({
    id: z.string().startsWith('usr_'),
    email: z.string().max(320),
    name: z.string(),
    bio: z.string().nullable(),
    age: int32().nullable(),
    score: int32(),
    active: z.boolean(),
    verified: z.boolean(),
    role: z.string(),
    plan: z.string(),
    locale: z.string().max(16),
    avatar: z.string().nullable(),
    profile: jsonValue.nullable(),
    createdAt: z.date(),
    updatedAt: z.date().nullable(),
  });

const handInsert = () =>
  z.object({
    id: z.string().startsWith('usr_'),
    email: z.string().max(320),
    name: z.string(),
    bio: z.string().nullable().optional(),
    age: int32().nullable().optional(),
    score: int32(),
    active: z.boolean(),
    verified: z.boolean(),
    role: z.string(),
    plan: z.string(),
    locale: z.string().max(16),
    avatar: z.string().nullable().optional(),
    profile: jsonValue.nullable().optional(),
    createdAt: z.date(),
    updatedAt: z.date().nullable().optional(),
  });

type Parser = {
  safeParse(value: unknown): { success: boolean; error?: { issues: readonly { path: readonly PropertyKey[] }[] } };
};

/** `ok`, or `error:` plus the dotted path of the first issue. */
function outcome(schema: Parser, row: Row): string {
  const result = schema.safeParse(row);
  if (result.success) return 'ok';
  return `error:${(result.error?.issues[0]?.path ?? []).map(String).join('.')}`;
}

const SELECT_CONTRACT = {
  id: 'contracts-parse-select/v1',
  description:
    'the outcome of parsing a table row, `ok` or `error:<path of the first issue>`; a row whose id does not start with `usr_` is an error on `id`',
};
const INSERT_CONTRACT = {
  id: 'contracts-parse-insert/v1',
  description:
    'the outcome of parsing an insert payload, `ok` or `error:<path of the first issue>`; nullable columns may be left out; a wrong id prefix is an error on `id`',
};
const NO_PREFIX_CHECK = 'does not check the ID prefix (accepts `org_abc123` as a user id)';

export default defineSuite({
  id: '@arki/contracts',
  intro:
    'Building and using Zod schemas from a 15-column Drizzle table with `@arki/contracts`, against `drizzle-orm/zod` (which it wraps) and a hand-written Zod object. Each table only ranks code that gave the same answer on every checked row.',
  notes: [
    '`@arki/contracts` calls `drizzle-orm/zod`, then adds the per-column runtime schemas that ID factories stash on a column. Its extra work is the ID prefix check; plain `drizzle-orm/zod` does not do it, so it is shown without a ratio.',
    'The hand-written object checks the prefix too, and the same rules the table implies (32-bit integers, a JSON value in the `jsonb` column), but it never reads the table: it shows the floor for building and parsing, not a replacement that stays in sync with the table.',
    'Building usually happens once at startup; parsing happens on every row.',
  ],
  groups: [
    compare<Probe>({
      id: 'build-select',
      title: 'Build the select schema (15 columns)',
      contract: {
        id: 'contracts-build-select/v1',
        description:
          'a schema whose outcome on each probe row is `ok` or `error:<path of the first issue>`, with the ID prefix checked',
      },
      inputs: selectProbes,
      expected: probe => probe.expected,
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/contracts createSelectSchema',
          package: '@arki/contracts',
          setup: probe => probe,
          run: probe => ({ schema: createSelectSchema(users), probe }),
          normalize: ({ schema, probe }) => outcome(schema, probe.row),
        }),
        hand: c({
          label: 'hand-written z.object',
          package: 'zod',
          setup: probe => probe,
          run: probe => ({ schema: handSelect(), probe }),
          normalize: ({ schema, probe }) => outcome(schema, probe.row),
        }),
        drizzle: c({
          label: 'drizzle-orm/zod createSelectSchema',
          package: 'drizzle-orm',
          differs: NO_PREFIX_CHECK,
          setup: probe => probe,
          run: probe => ({ schema: drizzleSelect(users), probe }),
          normalize: ({ schema, probe }) => outcome(schema, probe.row),
        }),
      }),
    }),
    compare<Probe>({
      id: 'build-insert',
      title: 'Build the insert schema (15 columns)',
      contract: {
        id: 'contracts-build-insert/v1',
        description:
          'a schema whose outcome on each probe payload is `ok` or `error:<path of the first issue>`, with the ID prefix checked',
      },
      inputs: insertProbes,
      expected: probe => probe.expected,
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/contracts createInsertSchema',
          package: '@arki/contracts',
          setup: probe => probe,
          run: probe => ({ schema: createInsertSchema(users), probe }),
          normalize: ({ schema, probe }) => outcome(schema, probe.row),
        }),
        hand: c({
          label: 'hand-written z.object',
          package: 'zod',
          setup: probe => probe,
          run: probe => ({ schema: handInsert(), probe }),
          normalize: ({ schema, probe }) => outcome(schema, probe.row),
        }),
        drizzle: c({
          label: 'drizzle-orm/zod createInsertSchema',
          package: 'drizzle-orm',
          differs: NO_PREFIX_CHECK,
          setup: probe => probe,
          run: probe => ({ schema: drizzleInsert(users), probe }),
          normalize: ({ schema, probe }) => outcome(schema, probe.row),
        }),
      }),
    }),
    compare<Probe>({
      id: 'parse-select',
      title: 'Parse one row',
      contract: SELECT_CONTRACT,
      inputs: selectProbes,
      expected: probe => probe.expected,
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/contracts select schema',
          package: '@arki/contracts',
          setup: probe => ({ schema: createSelectSchema(users), row: probe.row }),
          run: ({ schema, row }) => outcome(schema, row),
        }),
        hand: c({
          label: 'hand-written z.object',
          package: 'zod',
          setup: probe => ({ schema: handSelect(), row: probe.row }),
          run: ({ schema, row }) => outcome(schema, row),
        }),
        drizzle: c({
          label: 'drizzle-orm/zod select schema',
          package: 'drizzle-orm',
          differs: NO_PREFIX_CHECK,
          setup: probe => ({ schema: drizzleSelect(users), row: probe.row }),
          run: ({ schema, row }) => outcome(schema, row),
        }),
      }),
    }),
    compare<Probe>({
      id: 'parse-insert',
      title: 'Parse one insert payload',
      contract: INSERT_CONTRACT,
      inputs: insertProbes,
      expected: probe => probe.expected,
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/contracts insert schema',
          package: '@arki/contracts',
          setup: probe => ({ schema: createInsertSchema(users), row: probe.row }),
          run: ({ schema, row }) => outcome(schema, row),
        }),
        hand: c({
          label: 'hand-written z.object',
          package: 'zod',
          setup: probe => ({ schema: handInsert(), row: probe.row }),
          run: ({ schema, row }) => outcome(schema, row),
        }),
        drizzle: c({
          label: 'drizzle-orm/zod insert schema',
          package: 'drizzle-orm',
          differs: NO_PREFIX_CHECK,
          setup: probe => ({ schema: drizzleInsert(users), row: probe.row }),
          run: ({ schema, row }) => outcome(schema, row),
        }),
      }),
    }),
  ],
});
