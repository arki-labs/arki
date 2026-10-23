/**
 * `@arki/auth/sqlite/workspaces` — the workspace tables on SQLite. Node and Bun.
 *
 * The pure vocabulary (roles, `WorkspaceContext`, `Scope`, `WorkspaceScopeError`) lives on
 * `@arki/auth/workspaces`. The scoping kernel builds Postgres filters and stays on
 * `@arki/auth/pg/workspaces`.
 */
export { createWorkspaceForeignKeys, createWorkspaceTables } from './schema.js';
export type { CreateWorkspaceTablesOptions, OrganizationId, TeamId } from './schema.js';
