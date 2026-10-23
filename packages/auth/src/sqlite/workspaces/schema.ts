import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';

import type { AnyColumnSpec, ColumnKit } from '@arki/db/columns';
import { idColumns } from '@arki/db/sqlite';

import type { AuthColumnFill } from '../../schema/column-options.js';
import type { CreateWorkspaceTablesOptions } from '../../schema/workspace-tables.js';
import { organizationId, teamId } from '../../id-declarations.js';
import { workspaceTables } from '../../schema/workspace-tables.js';

export type { OrganizationId, TeamId } from '../../workspaces.js';
export type { CreateWorkspaceTablesOptions } from '../../schema/workspace-tables.js';

const organizationIdColumns = idColumns(organizationId);
const teamIdColumns = idColumns(teamId);

/**
 * The workspace scope FK factories bound to an app's `Organization` / `Team` id columns, for its
 * SQLite feature tables. Same contract as on `@arki/auth/pg/workspaces`: the columns are branded
 * `OrganizationId` / `TeamId`, and `onDelete: 'cascade'` deletes a row with its workspace.
 */
export function createWorkspaceForeignKeys(organizationIdColumn: () => SQLiteColumn, teamIdColumn: () => SQLiteColumn) {
  return {
    orgForeignKeys: organizationIdColumns.createForeignKeyFactory(organizationIdColumn),
    teamForeignKeys: teamIdColumns.createForeignKeyFactory(teamIdColumn),
  };
}

/**
 * The five tables of the Better Auth organization plugin with teams on SQLite, plus the scope FK
 * factories from `createWorkspaceForeignKeys` bound to them.
 *
 * @example
 * ```typescript
 * export const { Organization, Member, Invitation, Team, TeamMember, orgForeignKeys, teamForeignKeys } =
 *   createWorkspaceTables(sqliteColumns({ prefix: 'auth_' }), {
 *     fill: 'app',
 *     user: User,
 *     ids: { organization: organizationIdSource, member: memberIdSource, ... },
 *   });
 * ```
 */
export function createWorkspaceTables<
  TOrganizationId extends AnyColumnSpec<'sqlite'>,
  TMemberId extends AnyColumnSpec<'sqlite'>,
  TInvitationId extends AnyColumnSpec<'sqlite'>,
  TTeamId extends AnyColumnSpec<'sqlite'>,
  TTeamMemberId extends AnyColumnSpec<'sqlite'>,
  TFill extends AuthColumnFill,
>(
  c: ColumnKit<'sqlite'>,
  options: CreateWorkspaceTablesOptions<'sqlite', TOrganizationId, TMemberId, TInvitationId, TTeamId, TTeamMemberId, TFill>,
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
