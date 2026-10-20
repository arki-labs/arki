/**
 * The tables an app owns, as the first-15-minutes recipe builds them: the four auth tables with
 * two extra user columns (`plan` exposed, `stripeCustomerId` kept server-side), and the workspace
 * tables. Shared by the flow tests.
 */
import { jsonb, pgSchema, text } from 'drizzle-orm/pg-core';

import { defineId } from '@arki/contracts';
import { idColumns } from '@arki/db/id';

import { accountIdColumns, sessionIdColumns, userIdColumns, verificationIdColumns } from '../pg/ids.js';
import { createAuthTables } from '../pg/schema/index.js';
import { createWorkspaceTables } from '../pg/workspaces/schema.js';

const schema = pgSchema('notes');

export const authTables = createAuthTables(schema, {
  fill: 'app',
  ids: {
    user: userIdColumns,
    session: sessionIdColumns,
    account: accountIdColumns,
    verification: verificationIdColumns,
  },
  columns: {
    user: {
      plan: text('plan', { enum: ['free', 'pro'] })
        .notNull()
        .default('free'),
      stripeCustomerId: text('stripe_customer_id'),
      preferences: jsonb('preferences').$type<{ readonly theme: string }>(),
    },
    // The selected workspace, written by the organization plugin.
    session: { activeOrganizationId: text('active_organization_id'), activeTeamId: text('active_team_id') },
  },
});

export const workspaceTables = createWorkspaceTables(schema, {
  fill: 'app',
  user: { id: authTables.User.id },
  ids: {
    organization: idColumns(defineId('org_')),
    member: idColumns(defineId('mem_')),
    invitation: idColumns(defineId('inv_')),
    team: idColumns(defineId('team_')),
    teamMember: idColumns(defineId('tmem_')),
  },
});

export const allTables = { ...authTables, ...workspaceTables };
