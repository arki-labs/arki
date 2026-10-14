import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';

import type { OrganizationId, TeamId } from './schema';

/**
 * Workspace roles, highest privilege first. Mirrors Better Auth's default
 * organization roles. `rankRole` turns these into a comparable number so
 * `shareRole` gates ("at least admin") are a single `>=`.
 */
export type WorkspaceRole = 'owner' | 'admin' | 'member';

const ROLE_RANK: Record<WorkspaceRole, number> = { owner: 3, admin: 2, member: 1 };

/** Numeric rank for a role (higher = more privilege). `null` ranks below member. */
export function rankRole(role: WorkspaceRole | null): number {
  return role ? ROLE_RANK[role] : 0;
}

/** `true` when `role` is at least `min` in the privilege order. */
export function roleAtLeast(role: WorkspaceRole | null, min: WorkspaceRole): boolean {
  return rankRole(role) >= rankRole(min);
}

/**
 * The active-workspace context resolved from the session for the current
 * request. `activeOrganizationId === null` means the user is in their personal
 * scope; `memberTeamIds` are the teams the user belongs to *within the active
 * organization* (empty when personal or when the user is on no team).
 */
export type WorkspaceContext = {
  userId: string;
  activeOrganizationId: OrganizationId | null;
  /** The session's active team within the active org (for team-scoped writes/UI). */
  activeTeamId: TeamId | null;
  memberTeamIds: TeamId[];
  role: WorkspaceRole | null;
};

/**
 * A concrete ownership scope for a single row (D-WS-007). The three legal
 * shapes are:
 *
 * - personal: `{ organizationId: null, teamId: null }`
 * - org-wide: `{ organizationId: <org>, teamId: null }`
 * - team:     `{ organizationId: <org>, teamId: <team> }`
 *
 * `{ organizationId: null, teamId: <team> }` is illegal and rejected.
 */
export type Scope = {
  organizationId: OrganizationId | null;
  teamId: TeamId | null;
};

/** A stored row's owner plus its scope — what a move must check before it runs. */
export type RowScope = Scope & { userId: string };

/** The three scope levels, named. */
export type ScopeLevel = 'personal' | 'org' | 'team';

/** Classify a {@link Scope} into its level, throwing on the illegal shape. */
export function scopeLevel(scope: Scope): ScopeLevel {
  if (scope.organizationId === null) {
    if (scope.teamId !== null) {
      throw new WorkspaceScopeError('A team-scoped row must also carry an organization id.');
    }
    return 'personal';
  }
  return scope.teamId === null ? 'org' : 'team';
}

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
   * (D-WS-009). avocabo uses this to re-scope a source's ContentItems and flag
   * them for re-clustering.
   */
  onReassign?: (ctx: WorkspaceContext, rowId: string, target: Scope) => Promise<void>;
};

/** Thrown when a workspace write/move is not permitted, or a scope is malformed. */
export class WorkspaceScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceScopeError';
  }
}
