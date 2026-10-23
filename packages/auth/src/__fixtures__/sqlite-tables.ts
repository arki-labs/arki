/**
 * The same app tables as `./tables.ts`, built on SQLite: the four auth tables with the same
 * extra columns, and the workspace tables. Shared by the libSQL flow tests.
 */
import { defineId } from '@arki/contracts';
import { sqliteColumns } from '@arki/db/sqlite';

import { createAuthTables } from '../schema/auth-tables.js';
import { authIdSources } from '../sqlite/ids.js';
import { createWorkspaceTables } from '../sqlite/workspaces/schema.js';

const c = sqliteColumns({ prefix: 'notes_' });

export const authTables = createAuthTables(c, {
  fill: 'app',
  ids: authIdSources,
  columns: {
    user: {
      plan: c.text('plan', { enum: ['free', 'pro'] }).notNull().default('free'),
      stripeCustomerId: c.text('stripe_customer_id'),
      preferences: c.json('preferences').$type<{ readonly theme: string }>(),
    },
    // The selected workspace, written by the organization plugin.
    session: { activeOrganizationId: c.text('active_organization_id'), activeTeamId: c.text('active_team_id') },
  },
});

export const workspaceTables = createWorkspaceTables(c, {
  fill: 'app',
  user: { id: authTables.User.id },
  ids: {
    organization: c.id(defineId('org_')),
    member: c.id(defineId('mem_')),
    invitation: c.id(defineId('inv_')),
    team: c.id(defineId('team_')),
    teamMember: c.id(defineId('tmem_')),
  },
});

export const allTables = { ...authTables, ...workspaceTables };
