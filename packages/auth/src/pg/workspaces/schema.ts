import type { AnyPgColumn, AnyPgColumnBuilder, PgColumn, PgSchema } from 'drizzle-orm/pg-core';
import { integer, text, timestamp } from 'drizzle-orm/pg-core';

import { createIdFactory } from '@arki/db/id';

import type { OrganizationId, TeamId } from '../../workspaces.js';
import type { AuthColumnFill, AuthColumnOptions, PrimaryColumnSource } from '../schema/column-options.js';
import { byFill, columnNamer, filledAt } from '../schema/column-options.js';

/**
 * Branded ids for the Better Auth organization-plugin entities (D-WS-007).
 *
 * The prefixes match Better Auth's default `generateId` (model name + `_`), so
 * these brands are HONEST against the runtime ids the plugin generates
 * (`organization_…`, `team_…`) and `…IdSchema.parse()` succeeds on them.
 *
 * Co-locating the brands, the `@arki/db/id` FK factories, and the scoping
 * kernel in this one module is deliberate: a feature table's scope column and
 * the kernel's `Scope` end up the SAME branded type, so kernel scope values flow
 * into Drizzle writes with no casts.
 */
export type { OrganizationId, TeamId } from '../../workspaces.js';

const organizationIdFactory = createIdFactory<'organization_', OrganizationId>('organization_');
const teamIdFactory = createIdFactory<'team_', TeamId>('team_');

/** Zod schemas to validate + narrow a raw string into a branded id at a trust boundary. */
export const organizationIdSchema = organizationIdFactory.schema;
export const teamIdSchema = teamIdFactory.schema;

/**
 * Build the workspace scope FK factories bound to an app's `Organization` /
 * `Team` id columns (D-WS-005). Each app calls this once and uses the returned
 * factories on its scopable feature tables:
 *
 *   const { orgForeignKeys, teamForeignKeys } =
 *     createWorkspaceForeignKeys(() => Organization.id, () => Team.id);
 *   // on a feature table:
 *   organizationId: orgForeignKeys.optional('organization_id', { onDelete: 'cascade' }),
 *   teamId: teamForeignKeys.optional('team_id', { onDelete: 'cascade' }),
 *
 * The produced columns are `varchar(256)` branded `OrganizationId` / `TeamId`,
 * so they unify with the kernel's `Scope`. `onDelete: 'cascade'` implements the
 * D-WS-008 destroy-on-delete contract.
 */
export function createWorkspaceForeignKeys(organizationIdColumn: () => PgColumn, teamIdColumn: () => PgColumn) {
  return {
    orgForeignKeys: organizationIdFactory.createForeignKeyFactory(organizationIdColumn),
    teamForeignKeys: teamIdFactory.createForeignKeyFactory(teamIdColumn),
  };
}

/** `invitations.status`: `'pending'` until the invitee answers. */
const invitationStatus = byFill({
  app: name =>
    text(name)
      .notNull()
      .$defaultFn(() => 'pending'),
  database: name => text(name).notNull().default('pending'),
});

/** `teams.memberCount`: kept by Better Auth's organization plugin (`teams: true`). */
const memberCount = byFill({
  app: name =>
    integer(name)
      .notNull()
      .$defaultFn(() => 0),
  database: name => integer(name).notNull().default(0),
});

export type CreateWorkspaceTablesOptions<
  TOrganizationId extends AnyPgColumnBuilder,
  TMemberId extends AnyPgColumnBuilder,
  TInvitationId extends AnyPgColumnBuilder,
  TTeamId extends AnyPgColumnBuilder,
  TTeamMemberId extends AnyPgColumnBuilder,
  TFill extends AuthColumnFill,
> = AuthColumnOptions<TFill> & {
  /** The app's `User` table. Members, invitations and team members point at its `id`. */
  user: { id: AnyPgColumn };
  /** The app's id sources, one per table. The lib never makes ids. */
  ids: {
    organization: PrimaryColumnSource<TOrganizationId>;
    member: PrimaryColumnSource<TMemberId>;
    invitation: PrimaryColumnSource<TInvitationId>;
    team: PrimaryColumnSource<TTeamId>;
    teamMember: PrimaryColumnSource<TTeamMemberId>;
  };
};

/**
 * The five tables of the Better Auth organization plugin with teams
 * (`organizations`, `members`, `invitations`, `teams`, `team_members`), plus
 * the scope FK factories from `createWorkspaceForeignKeys` bound to them.
 *
 * Column keys mirror the plugin's model fields, because the Better Auth
 * Drizzle adapter maps each field to the identically-named column. Rows that
 * belong to an organization, a team or a user go away with it
 * (`onDelete: 'cascade'`, D-WS-008). `invitations.teamId` is a plain column:
 * the plugin keeps it without a foreign key.
 *
 * @example
 * ```typescript
 * export const { Organization, Member, Invitation, Team, TeamMember, orgForeignKeys, teamForeignKeys } =
 *   createWorkspaceTables(schema, {
 *     naming: 'camel',
 *     fill: 'database',
 *     user: User,
 *     ids: { organization: organizationIdSource, member: memberIdSource, ... },
 *   });
 * ```
 */
export function createWorkspaceTables<
  TOrganizationId extends AnyPgColumnBuilder,
  TMemberId extends AnyPgColumnBuilder,
  TInvitationId extends AnyPgColumnBuilder,
  TTeamId extends AnyPgColumnBuilder,
  TTeamMemberId extends AnyPgColumnBuilder,
  TFill extends AuthColumnFill,
>(
  schema: PgSchema,
  {
    naming,
    fill,
    user,
    ids,
  }: CreateWorkspaceTablesOptions<TOrganizationId, TMemberId, TInvitationId, TTeamId, TTeamMemberId, TFill>,
) {
  const name = columnNamer(naming);
  const cascade = { onDelete: 'cascade' } as const;

  const Organization = schema.table('organizations', {
    id: ids.organization.primaryColumn(),
    name: text(name('name')).notNull(),
    slug: text(name('slug')).notNull().unique(),
    logo: text(name('logo')),
    // Better Auth serializes organization metadata to a JSON string.
    metadata: text(name('metadata')),
    createdAt: filledAt(fill, name('createdAt')),
  });

  const organizationReference = () =>
    text(name('organizationId'))
      .notNull()
      .references(() => Organization.id, cascade);

  const userReference = () =>
    text(name('userId'))
      .notNull()
      .references(() => user.id, cascade);

  const Member = schema.table('members', {
    id: ids.member.primaryColumn(),
    organizationId: organizationReference(),
    userId: userReference(),
    role: text(name('role')).notNull(),
    createdAt: filledAt(fill, name('createdAt')),
  });

  const Invitation = schema.table('invitations', {
    id: ids.invitation.primaryColumn(),
    organizationId: organizationReference(),
    email: text(name('email')).notNull(),
    role: text(name('role')).notNull(),
    status: invitationStatus(fill, name('status')),
    teamId: text(name('teamId')),
    inviterId: text(name('inviterId'))
      .notNull()
      .references(() => user.id, cascade),
    expiresAt: timestamp(name('expiresAt')).notNull(),
    createdAt: filledAt(fill, name('createdAt')),
  });

  const Team = schema.table('teams', {
    id: ids.team.primaryColumn(),
    name: text(name('name')).notNull(),
    organizationId: organizationReference(),
    memberCount: memberCount(fill, name('memberCount')),
    createdAt: filledAt(fill, name('createdAt')),
    updatedAt: timestamp(name('updatedAt')),
  });

  const TeamMember = schema.table('team_members', {
    id: ids.teamMember.primaryColumn(),
    teamId: text(name('teamId'))
      .notNull()
      .references(() => Team.id, cascade),
    userId: userReference(),
    // Written by Better Auth's organization plugin; never returned to clients.
    membershipKey: text(name('membershipKey')).unique(),
    createdAt: filledAt(fill, name('createdAt')),
  });

  return {
    Organization,
    Member,
    Invitation,
    Team,
    TeamMember,
    ...createWorkspaceForeignKeys(
      () => Organization.id,
      () => Team.id,
    ),
  };
}
