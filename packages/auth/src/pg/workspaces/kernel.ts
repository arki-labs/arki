import type { SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';

import { isFailure } from '@arki/failure';

import type { RowScope, Scope, WorkspaceContext, WorkspaceRole } from '../../workspaces.js';
import { AccessDenied, ResourceMissing } from '../../boundary-failures.js';
import { log } from '../../log.js';
import { roleAtLeast, scopeLevel, WorkspaceScopeError } from '../../workspaces.js';

/**
 * The workspace scoping kernel (D-WS-002). Two responsibilities:
 *
 * 1. READ — {@link workspaceReadFilter} builds the single 3-level visibility
 *    predicate every scoped query must AND into its WHERE, so the tenant
 *    predicate is defined in exactly one place and can't drift per query.
 * 2. WRITE — {@link resolveWriteScope} is the gate every create/move passes
 *    through: it validates the actor's rights at the *target* scope and returns
 *    the scope columns to persist (or throws). {@link reassignScope} sequences a
 *    scope move + its registered cascade.
 *
 * The kernel owns the DECISION (predicate + gating + cascade orchestration); the
 * caller owns the typed EXECUTION (it runs the actual Drizzle update with its own
 * app-typed db handle), so this shared package stays free of db-generic coupling.
 */

/**
 * Registration for one workspace-scopable table (D-WS-005/007/009). The app
 * calls {@link registerWorkspaceResource} once per table; the kernel reads this
 * to build read predicates, gate writes, and run reassignment cascades.
 */
export type WorkspaceResourceConfig = {
  table: PgTable;
  /** Primary-key column — used by {@link reassignScope} to target a row. */
  idColumn: PgColumn;
  /** Existing actor/creator column (kept on every row). */
  userColumn: PgColumn;
  /** Nullable `organization_id` column. */
  orgColumn: PgColumn;
  /** Nullable `team_id` column. Omit for resources that are org-only. */
  teamColumn?: PgColumn;
  /** Minimum role to create/move an ORG-WIDE row. Defaults to `'member'`. */
  shareRole?: WorkspaceRole;
  /**
   * Cascade run inside the same transaction after a row's scope changes
   * (D-WS-009). For example, an app can re-scope the rows that belong to the
   * moved row in the same transaction.
   */
  onReassign?: (ctx: WorkspaceContext, rowId: string, target: Scope) => Promise<void>;
};

const registry = new Map<PgTable, WorkspaceResourceConfig>();

/**
 * Register a workspace-scopable table (D-WS-005/007/009). Idempotent — calling
 * again with the same table overwrites the prior config.
 */
export function registerWorkspaceResource(config: WorkspaceResourceConfig): void {
  registry.set(config.table, config);
}

/** Look up a registered resource, throwing if the table was never registered. */
export function getWorkspaceResource(table: PgTable): WorkspaceResourceConfig {
  const config = registry.get(table);
  if (!config) {
    throw new WorkspaceScopeError(
      'Table is not registered as a workspace resource. Call registerWorkspaceResource() first.',
    );
  }
  return config;
}

/** Test/bootstrap helper — clears the registry. */
export function resetWorkspaceRegistry(): void {
  registry.clear();
}

/**
 * Build the 3-level visibility predicate for `ctx` (D-WS-007):
 *
 *   personal  : organization_id IS NULL AND user_id = :me
 *   org-wide  : organization_id = :activeOrg AND team_id IS NULL
 *   team      : organization_id = :activeOrg AND team_id IN :myTeams
 *
 * Branches that don't apply to the current context (no active org, no team
 * memberships, or a resource with no team column) are omitted. Org-only
 * resources collapse "org-wide" to `organization_id = :activeOrg`.
 *
 * AND this into every scoped read's WHERE. Never dedups across scope (D-WS-006);
 * callers that cluster must include (organization_id, team_id) in their key.
 */
export function workspaceReadFilter(config: WorkspaceResourceConfig, ctx: WorkspaceContext): SQL {
  const { userColumn, orgColumn, teamColumn } = config;

  const personal = and(isNull(orgColumn), eq(userColumn, ctx.userId));

  const orgWide = ctx.activeOrganizationId
    ? teamColumn
      ? and(eq(orgColumn, ctx.activeOrganizationId), isNull(teamColumn))
      : eq(orgColumn, ctx.activeOrganizationId)
    : undefined;

  const team =
    ctx.activeOrganizationId && teamColumn && ctx.memberTeamIds.length > 0
      ? and(eq(orgColumn, ctx.activeOrganizationId), inArray(teamColumn, ctx.memberTeamIds))
      : undefined;

  // `or` drops undefined branches; at least `personal` is always present.
  const filter = or(personal, orgWide, team);
  if (!filter) {
    // Unreachable — `personal` is always defined — but keeps the return type SQL.
    throw new WorkspaceScopeError('Failed to build workspace read filter.');
  }
  return filter;
}

/**
 * Validate a write at `target` scope and return the scope columns to persist
 * (D-WS-005/007/009). Returns {@link AccessDenied} (403) when the actor lacks
 * rights at the target scope; the reason goes to the DEBUG log, never to the caller.
 * A scope of an illegal shape, or a resource without a team column asked for a team
 * scope, is a bug in the caller and still throws {@link WorkspaceScopeError}.
 * This is the single gate for every shared create and every scope move.
 *
 * - personal: always allowed (the row's `user_id` is the actor).
 * - org-wide: requires `target.org === activeOrg` AND role ≥ `shareRole`.
 * - team:     requires the resource has a team column, `target.org === activeOrg`,
 *             AND the actor is a member of `target.team`.
 */
export function resolveWriteScope(
  config: WorkspaceResourceConfig,
  target: Scope,
  ctx: WorkspaceContext,
): Scope | ReturnType<typeof AccessDenied> {
  const level = scopeLevel(target);

  if (level === 'personal') {
    return { organizationId: null, teamId: null };
  }

  if (target.organizationId !== ctx.activeOrganizationId) {
    return denied('write into an organization other than the active one', ctx);
  }

  if (level === 'org') {
    const min = config.shareRole ?? 'member';
    if (!roleAtLeast(ctx.role, min)) {
      return denied(`org-wide write needs the "${min}" role or higher`, ctx);
    }
    return { organizationId: target.organizationId, teamId: null };
  }

  // level === 'team'
  if (!config.teamColumn) {
    throw new WorkspaceScopeError('This resource is not team-scopable (no team column registered).');
  }
  if (target.teamId === null || !ctx.memberTeamIds.includes(target.teamId)) {
    return denied('write into a team the actor is not a member of', ctx);
  }
  return { organizationId: target.organizationId, teamId: target.teamId };
}

/** The refusal of a write: a generic 403 for the caller, the reason in the DEBUG log. */
function denied(reason: string, ctx: WorkspaceContext) {
  log.debug('workspace write refused: {reason}', { reason, userId: ctx.userId });
  return AccessDenied();
}

/**
 * `true` when `ctx` can see a row stored at `row` — the same three branches as
 * {@link workspaceReadFilter}, evaluated in memory for one row:
 *
 * - personal: the row's owner is the actor.
 * - org-wide: the row sits in the active organization.
 * - team:     the row sits in the active organization AND the actor is on its team.
 */
export function canSeeRow(config: WorkspaceResourceConfig, row: RowScope, ctx: WorkspaceContext): boolean {
  if (row.organizationId === null) {
    return row.userId === ctx.userId;
  }
  if (row.organizationId !== ctx.activeOrganizationId) {
    return false;
  }
  if (row.teamId === null || !config.teamColumn) {
    return true;
  }
  return ctx.memberTeamIds.includes(row.teamId);
}

/**
 * Move an existing row to `target` scope (D-WS-009). Returns {@link ResourceMissing} when the
 * actor cannot see the row where it is now (a hidden row looks exactly like a missing one) and
 * {@link AccessDenied} when the actor may not write at `target`. Validates rights at the
 * target via {@link resolveWriteScope}, applies the caller's typed update with
 * the resolved scope, then runs the registered `onReassign` cascade — all
 * intended to run inside one transaction the caller controls.
 *
 * `current` is the row's owner and scope as stored now, read by the caller from
 * the db. The actor must be able to see the row where it is before moving it.
 * Without that check, anyone who learns a row id could pull another user's,
 * team's, or organization's row into a scope they can read. It is required, and
 * a missing value is refused at runtime too (fail closed for untyped callers).
 *
 * The caller supplies `applyUpdate` (it owns the app-typed Drizzle handle and
 * runs `db.update(table).set(...).where(eq(idColumn, rowId))`), so the kernel
 * never touches a concrete db type.
 */
export async function reassignScope(opts: {
  config: WorkspaceResourceConfig;
  rowId: string;
  target: Scope;
  ctx: WorkspaceContext;
  current: RowScope;
  applyUpdate: (resolved: Scope) => Promise<void>;
}): Promise<Scope | ReturnType<typeof AccessDenied> | ReturnType<typeof ResourceMissing>> {
  // `current` is typed as required; the runtime check also refuses a missing value from untyped callers.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!opts.current || !canSeeRow(opts.config, opts.current, opts.ctx)) {
    log.debug('workspace move refused: the row is not visible in its current scope', { userId: opts.ctx.userId });
    return ResourceMissing();
  }
  const resolved = resolveWriteScope(opts.config, opts.target, opts.ctx);
  if (isFailure(resolved)) return resolved;
  await opts.applyUpdate(resolved);
  await opts.config.onReassign?.(opts.ctx, opts.rowId, resolved);
  return resolved;
}
