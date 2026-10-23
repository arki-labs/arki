/**
 * Moving the tables to the column kit must not change a single row type an app already has: the
 * kit-built Postgres tables are compared with the same tables written with `drizzle-orm/pg-core`,
 * the way `createAuthTables` built them before.
 */
import { boolean, integer, pgSchema, text, timestamp } from 'drizzle-orm/pg-core';
import { describe, expectTypeOf, it } from 'vitest';

import { defineId } from '@arki/contracts';
import { idColumns } from '@arki/db/id';
import { pgColumns } from '@arki/db/pg';
import { sqliteColumns } from '@arki/db/sqlite';

import { authIdSources, userIdColumns } from '../pg/ids.js';
import { createWorkspaceTables } from '../pg/workspaces/schema.js';
import { createAuthTables } from './auth-tables.js';

const schema = pgSchema('notes');
const c = pgColumns(schema);
const organizationId = defineId('org_');
const memberId = defineId('mem_');
const sqliteText = sqliteColumns().text('plan');

const kit = createAuthTables(c, {
  fill: 'app',
  ids: authIdSources,
  columns: { user: { plan: c.text('plan', { enum: ['free', 'pro'] }).notNull().default('free') } },
});
const kitWorkspaces = createWorkspaceTables(c, {
  fill: 'database',
  user: kit.User,
  ids: {
    organization: c.id(organizationId),
    member: c.id(memberId),
    invitation: c.id(defineId('inv_')),
    team: c.id(defineId('team_')),
    teamMember: c.id(defineId('tmem_')),
  },
});

const User = schema.table('users', {
  id: userIdColumns.primaryColumn(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified')
    .notNull()
    .$defaultFn(() => false),
  image: text('image'),
  createdAt: timestamp('created_at')
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: timestamp('updated_at')
    .notNull()
    .$defaultFn(() => new Date()),
  plan: text('plan', { enum: ['free', 'pro'] })
    .notNull()
    .default('free'),
});
const _Session = schema.table('sessions', {
  id: idColumns(defineId('sess_')).primaryColumn(),
  expiresAt: timestamp('expires_at').notNull(),
  token: text('token').notNull().unique(),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id')
    .notNull()
    .$type<typeof User.id._.data>()
    .references(() => User.id, { onDelete: 'cascade' }),
});
const _Member = schema.table('members', {
  id: idColumns(memberId).primaryColumn(),
  organizationId: text('organization_id').notNull(),
  userId: text('user_id').notNull(),
  role: text('role').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});
const _Team = schema.table('teams', {
  id: idColumns(defineId('team_')).primaryColumn(),
  name: text('name').notNull(),
  organizationId: text('organization_id').notNull(),
  memberCount: integer('member_count').notNull().default(0),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at'),
});

describe('createAuthTables on Postgres', () => {
  it('keeps the row types apps had with pg-core tables', () => {
    expectTypeOf<typeof kit.User.$inferSelect>().toEqualTypeOf<typeof User.$inferSelect>();
    expectTypeOf<typeof kit.User.$inferInsert>().toEqualTypeOf<typeof User.$inferInsert>();
    expectTypeOf<typeof kit.Session.$inferSelect>().toEqualTypeOf<typeof _Session.$inferSelect>();
    expectTypeOf<typeof kit.Session.$inferInsert>().toEqualTypeOf<typeof _Session.$inferInsert>();
  });

  it('keeps the workspace row types', () => {
    expectTypeOf<typeof kitWorkspaces.Member.$inferSelect>().toEqualTypeOf<typeof _Member.$inferSelect>();
    expectTypeOf<typeof kitWorkspaces.Team.$inferInsert>().toEqualTypeOf<typeof _Team.$inferInsert>();
  });

  it('still hands apps Postgres foreign key columns for their own tables', () => {
    const _Note = schema.table('notes', {
      id: text('id').primaryKey(),
      userId: kit.userForeignKeys.required('user_id'),
      organizationId: kitWorkspaces.orgForeignKeys.optional('organization_id'),
    });
    expectTypeOf<typeof _Note.$inferSelect.userId>().toEqualTypeOf<typeof User.$inferSelect.id>();
  });

  it('refuses a SQLite spec in a Postgres table', () => {
    createAuthTables(c, {
      fill: 'app',
      ids: authIdSources,
      // @ts-expect-error -- the kit's dialect must match the extra column's
      columns: { user: { plan: sqliteText } },
    });
  });
});
