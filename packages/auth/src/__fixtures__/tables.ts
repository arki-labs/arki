/**
 * The tables an app owns, as the first-15-minutes recipe builds them: the four auth tables with
 * two extra user columns (`plan` exposed, `stripeCustomerId` kept server-side), and the workspace
 * tables. Shared by the flow tests.
 */
import { pgSchema } from 'drizzle-orm/pg-core';

import { defineId } from '@arki/contracts';
import { pgColumns } from '@arki/db/pg';

import { authIdSources } from '../pg/ids.js';
import { createWorkspaceTables } from '../pg/workspaces/schema.js';
import { createAuthTables } from '../schema/auth-tables.js';

const c = pgColumns(pgSchema('notes'));

export const authTables = createAuthTables(c, {
  fill: 'app',
  ids: authIdSources,
  columns: {
    user: {
      plan: c
        .text('plan', { enum: ['free', 'pro'] })
        .notNull()
        .default('free'),
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
