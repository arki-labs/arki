/**
 * `@arki/auth/workspaces` — SERVER surface (D-WS-003).
 *
 * Tenancy substrate for flag-enabled team workspaces: the Better Auth
 * organization-plugin glue and the scoping kernel. Server-only — NO React here
 * (the browser surface lives at `@arki/auth/workspaces/ui`, added with the
 * frontend wiring). See
 * `apps/avocabo/docs/features/team-workspaces/pilot-spec.md`.
 */

export { organizationPlugin } from './plugin';
export type { WorkspacePluginOptions } from './plugin';

export {
  createWorkspaceForeignKeys,
  organizationIdSchema,
  teamIdSchema,
} from './schema';
export type { OrganizationId, TeamId } from './schema';

export {
  registerWorkspaceResource,
  getWorkspaceResource,
  resetWorkspaceRegistry,
  workspaceReadFilter,
  resolveWriteScope,
  reassignScope,
  canSeeRow,
} from './kernel';

export {
  rankRole,
  roleAtLeast,
  scopeLevel,
  WorkspaceScopeError,
} from './types';
export type {
  WorkspaceRole,
  WorkspaceContext,
  Scope,
  RowScope,
  ScopeLevel,
  WorkspaceResourceConfig,
} from './types';
