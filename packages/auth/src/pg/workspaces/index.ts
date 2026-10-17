/**
 * `@arki/auth/pg/workspaces` — the workspace tables and the scoping kernel. Node and Bun.
 *
 * The pure vocabulary (roles, `WorkspaceContext`, `Scope`, `WorkspaceScopeError`) lives on
 * `@arki/auth/workspaces`.
 */
export { createWorkspaceForeignKeys, createWorkspaceTables } from './schema.js';
export type { CreateWorkspaceTablesOptions, OrganizationId, TeamId } from './schema.js';
export {
  canSeeRow,
  getWorkspaceResource,
  reassignScope,
  registerWorkspaceResource,
  resetWorkspaceRegistry,
  resolveWriteScope,
  workspaceReadFilter,
} from './kernel.js';
export type { WorkspaceResourceConfig } from './kernel.js';
