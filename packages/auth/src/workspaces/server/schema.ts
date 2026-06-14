import type { PgColumn } from 'drizzle-orm/pg-core';

import { createIdFactory } from '@arki/db/id';

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
export type OrganizationId = `organization_${string}`;
export type TeamId = `team_${string}`;

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
export function createWorkspaceForeignKeys(
  organizationIdColumn: () => PgColumn,
  teamIdColumn: () => PgColumn,
) {
  return {
    orgForeignKeys: organizationIdFactory.createForeignKeyFactory(organizationIdColumn),
    teamForeignKeys: teamIdFactory.createForeignKeyFactory(teamIdColumn),
  };
}
