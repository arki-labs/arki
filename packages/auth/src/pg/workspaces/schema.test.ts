import { getTableConfig, pgSchema, text } from 'drizzle-orm/pg-core';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { createWorkspaceTables } from './schema.js';

const schema = pgSchema('test_app');

const User = schema.table('users', { id: text('id').primaryKey() });

const idSource = (prefix: string) => ({
  primaryColumn: () =>
    text('id')
      .primaryKey()
      .$defaultFn(() => `${prefix}_x`),
});

const ids = {
  organization: idSource('organization'),
  member: idSource('mem'),
  invitation: idSource('inv'),
  team: idSource('team'),
  teamMember: idSource('tmem'),
};

const column = (table: Parameters<typeof getTableConfig>[0], name: string) => {
  const found = getTableConfig(table).columns.find(c => c.name === name);
  if (!found) throw new Error(`no column ${name}`);
  return { notNull: found.notNull, sqlDefault: found.default !== undefined, jsDefault: found.defaultFn !== undefined };
};

const foreignKeys = (table: Parameters<typeof getTableConfig>[0]) =>
  getTableConfig(table).foreignKeys.map(fk => {
    const ref = fk.reference();
    return `${ref.columns.map(c => c.name).join(',')} -> ${getTableConfig(ref.foreignTable).name} ${fk.onDelete}`;
  });

describe('createWorkspaceTables', () => {
  const tables = createWorkspaceTables(schema, { naming: 'camel', fill: 'database', user: User, ids });

  it('builds the five organization-plugin tables', () => {
    expect(
      [tables.Organization, tables.Member, tables.Invitation, tables.Team, tables.TeamMember].map(
        t => getTableConfig(t).name,
      ),
    ).toEqual(['organizations', 'members', 'invitations', 'teams', 'team_members']);
  });

  it('cascades from organizations, teams and users; invitations.teamId has no foreign key', () => {
    expect(foreignKeys(tables.Member)).toEqual(['organizationId -> organizations cascade', 'userId -> users cascade']);
    expect(foreignKeys(tables.Invitation)).toEqual([
      'organizationId -> organizations cascade',
      'inviterId -> users cascade',
    ]);
    expect(foreignKeys(tables.Team)).toEqual(['organizationId -> organizations cascade']);
    expect(foreignKeys(tables.TeamMember)).toEqual(['teamId -> teams cascade', 'userId -> users cascade']);
  });

  it('keeps the plugin-maintained columns: memberCount, pending status, nullable unique membershipKey', () => {
    expect(column(tables.Team, 'memberCount')).toEqual({ notNull: true, sqlDefault: true, jsDefault: false });
    expect(column(tables.Invitation, 'status')).toEqual({ notNull: true, sqlDefault: true, jsDefault: false });
    expect(column(tables.Team, 'updatedAt')).toEqual({ notNull: false, sqlDefault: false, jsDefault: false });
    const membershipKey = getTableConfig(tables.TeamMember).columns.find(c => c.name === 'membershipKey');
    expect(membershipKey?.isUnique).toBe(true);
    expect(membershipKey?.notNull).toBe(false);
  });

  it("follows naming and fill: 'snake' + 'app' spells organization_id and fills from code", () => {
    const js = createWorkspaceTables(schema, { fill: 'app', user: User, ids });
    expect(getTableConfig(js.Member).columns.map(c => c.name)).toEqual([
      'id',
      'organization_id',
      'user_id',
      'role',
      'created_at',
    ]);
    expect(column(js.Team, 'member_count')).toEqual({ notNull: true, sqlDefault: false, jsDefault: true });
    expect(column(js.Invitation, 'status')).toEqual({ notNull: true, sqlDefault: false, jsDefault: true });
    expect(column(js.Organization, 'created_at')).toEqual({ notNull: true, sqlDefault: false, jsDefault: true });
    expectTypeOf<typeof js.Team.$inferInsert.memberCount>().toEqualTypeOf<number | undefined>();
  });

  it('returns the scope foreign key factories bound to its own organization and team tables', () => {
    const Note = schema.table('notes', {
      id: text('id').primaryKey(),
      organizationId: tables.orgForeignKeys.optional('organization_id', { onDelete: 'cascade' }),
      teamId: tables.teamForeignKeys.optional('team_id', { onDelete: 'cascade' }),
    });
    expect(foreignKeys(Note)).toEqual(['organization_id -> organizations cascade', 'team_id -> teams cascade']);
  });
});
