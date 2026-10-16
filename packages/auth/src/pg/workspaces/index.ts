/**
 * `@arki/auth/pg/workspaces` — the workspace tables and the scoping kernel. Node and Bun.
 *
 * The code still lives in `../../workspaces/server`; the delete step moves it here and leaves the
 * pure types on `@arki/auth/workspaces`.
 */
export { createWorkspaceForeignKeys, createWorkspaceTables } from '../../workspaces/server/schema.js';
export type { CreateWorkspaceTablesOptions, OrganizationId, TeamId } from '../../workspaces/server/schema.js';
export {
  canSeeRow,
  reassignScope,
  registerWorkspaceResource,
  resolveWriteScope,
  workspaceReadFilter,
} from '../../workspaces/server/kernel.js';
