import type { PgColumn } from 'drizzle-orm/pg-core';

import type { AnyColumnSpec, ColumnKit } from '@arki/db/columns';
import { idColumns } from '@arki/db/id';

import type { AuthColumnFill } from '../../schema/column-options.js';
import type { CreateWorkspaceTablesOptions } from '../../schema/workspace-tables.js';
import { organizationId, teamId } from '../../id-declarations.js';
import { workspaceTables } from '../../schema/workspace-tables.js';

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
export type { CreateWorkspaceTablesOptions } from '../../schema/workspace-tables.js';

const organizationIdColumns = idColumns(organizationId);
const teamIdColumns = idColumns(teamId);

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
    orgForeignKeys: organizationIdColumns.createForeignKeyFactory(organizationIdColumn),
    teamForeignKeys: teamIdColumns.createForeignKeyFactory(teamIdColumn),
  };
}

/**
 * The five tables of the Better Auth organization plugin with teams on Postgres
 * (`organizations`, `members`, `invitations`, `teams`, `team_members`), plus
 * the scope FK factories from `createWorkspaceForeignKeys` bound to them.
 *
 * @example
 * ```typescript
 * export const { Organization, Member, Invitation, Team, TeamMember, orgForeignKeys, teamForeignKeys } =
 *   createWorkspaceTables(pgColumns(schema), {
 *     naming: 'camel',
 *     fill: 'database',
 *     user: User,
 *     ids: { organization: organizationIdSource, member: memberIdSource, ... },
 *   });
 * ```
 */
export function createWorkspaceTables<
  TOrganizationId extends AnyColumnSpec<'pg'>,
  TMemberId extends AnyColumnSpec<'pg'>,
  TInvitationId extends AnyColumnSpec<'pg'>,
  TTeamId extends AnyColumnSpec<'pg'>,
  TTeamMemberId extends AnyColumnSpec<'pg'>,
  TFill extends AuthColumnFill,
>(
  c: ColumnKit<'pg'>,
  options: CreateWorkspaceTablesOptions<'pg', TOrganizationId, TMemberId, TInvitationId, TTeamId, TTeamMemberId, TFill>,
) {
  const tables = workspaceTables(c, options);
  return {
    ...tables,
    ...createWorkspaceForeignKeys(
      () => tables.Organization.id,
      () => tables.Team.id,
    ),
  };
}
