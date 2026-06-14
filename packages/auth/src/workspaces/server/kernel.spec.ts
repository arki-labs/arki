import { pgTable, text } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  reassignScope,
  registerWorkspaceResource,
  resetWorkspaceRegistry,
  resolveWriteScope,
  workspaceReadFilter,
} from './kernel';
import { WorkspaceScopeError } from './types';
import type { WorkspaceContext, WorkspaceResourceConfig } from './types';

// A team-scopable resource (id + actor + nullable org + nullable team).
const sourceTable = pgTable('test_source', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  organizationId: text('organization_id'),
  teamId: text('team_id'),
});

// An org-only resource (no team column) — exercises the collapsed org-wide path.
const orgOnlyTable = pgTable('test_org_only', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  organizationId: text('organization_id'),
});

const sourceConfig: WorkspaceResourceConfig = {
  table: sourceTable,
  idColumn: sourceTable.id,
  userColumn: sourceTable.userId,
  orgColumn: sourceTable.organizationId,
  teamColumn: sourceTable.teamId,
  shareRole: 'admin', // only admins may create/move ORG-WIDE rows
};

const orgOnlyConfig: WorkspaceResourceConfig = {
  table: orgOnlyTable,
  idColumn: orgOnlyTable.id,
  userColumn: orgOnlyTable.userId,
  orgColumn: orgOnlyTable.organizationId,
};

const personalCtx: WorkspaceContext = {
  userId: 'u1',
  activeOrganizationId: null,
  activeTeamId: null,
  memberTeamIds: [],
  role: null,
};
const adminCtx: WorkspaceContext = {
  userId: 'u1',
  activeOrganizationId: 'organization_1',
  activeTeamId: null,
  memberTeamIds: ['team_a'],
  role: 'admin',
};
const memberCtx: WorkspaceContext = {
  userId: 'u2',
  activeOrganizationId: 'organization_1',
  activeTeamId: 'team_a',
  memberTeamIds: ['team_a'],
  role: 'member',
};

beforeEach(() => {
  resetWorkspaceRegistry();
});

describe('resolveWriteScope — the shared-write gate', () => {
  it('always allows a personal write regardless of role', () => {
    expect(resolveWriteScope(sourceConfig, { organizationId: null, teamId: null }, personalCtx)).toEqual({
      organizationId: null,
      teamId: null,
    });
  });

  it('lets an admin create an org-wide row in the active org', () => {
    expect(
      resolveWriteScope(sourceConfig, { organizationId: 'organization_1', teamId: null }, adminCtx),
    ).toEqual({ organizationId: 'organization_1', teamId: null });
  });

  it('blocks a member from creating an org-wide row (shareRole = admin)', () => {
    expect(() =>
      resolveWriteScope(sourceConfig, { organizationId: 'organization_1', teamId: null }, memberCtx),
    ).toThrow(WorkspaceScopeError);
  });

  it('blocks writing into an organization other than the active one', () => {
    expect(() =>
      resolveWriteScope(sourceConfig, { organizationId: 'organization_2', teamId: null }, adminCtx),
    ).toThrow(/active one/i);
  });

  it('lets a team member create a team-scoped row', () => {
    expect(
      resolveWriteScope(sourceConfig, { organizationId: 'organization_1', teamId: 'team_a' }, memberCtx),
    ).toEqual({ organizationId: 'organization_1', teamId: 'team_a' });
  });

  it('blocks a non-member from writing into a team', () => {
    expect(() =>
      resolveWriteScope(sourceConfig, { organizationId: 'organization_1', teamId: 'team_b' }, memberCtx),
    ).toThrow(/not a member/i);
  });

  it('rejects a team write on an org-only resource', () => {
    expect(() =>
      resolveWriteScope(orgOnlyConfig, { organizationId: 'organization_1', teamId: 'team_a' }, adminCtx),
    ).toThrow(/not team-scopable/i);
  });

  it('rejects the illegal team-without-org scope shape', () => {
    expect(() =>
      resolveWriteScope(sourceConfig, { organizationId: null, teamId: 'team_a' }, adminCtx),
    ).toThrow(/organization id/i);
  });
});

describe('workspaceReadFilter — 3-level visibility predicate', () => {
  it('builds a predicate in the personal-only context', () => {
    expect(workspaceReadFilter(sourceConfig, personalCtx)).toBeDefined();
  });

  it('builds a predicate spanning personal + org + team when active', () => {
    expect(workspaceReadFilter(sourceConfig, adminCtx)).toBeDefined();
  });

  it('builds a predicate for an org-only resource (no team branch)', () => {
    expect(workspaceReadFilter(orgOnlyConfig, adminCtx)).toBeDefined();
  });
});

describe('reassignScope — move + cascade (D-WS-009)', () => {
  it('applies the update then runs onReassign, in that order', async () => {
    const calls: string[] = [];
    const onReassign = vi.fn((): Promise<void> => {
      calls.push('cascade');
      return Promise.resolve();
    });
    const applyUpdate = vi.fn((): Promise<void> => {
      calls.push('update');
      return Promise.resolve();
    });
    registerWorkspaceResource({ ...sourceConfig, onReassign });

    const resolved = await reassignScope({
      config: { ...sourceConfig, onReassign },
      rowId: 'src_1',
      target: { organizationId: 'organization_1', teamId: 'team_a' },
      ctx: memberCtx,
      applyUpdate,
    });

    expect(resolved).toEqual({ organizationId: 'organization_1', teamId: 'team_a' });
    expect(calls).toEqual(['update', 'cascade']);
    expect(onReassign).toHaveBeenCalledWith(memberCtx, 'src_1', {
      organizationId: 'organization_1',
      teamId: 'team_a',
    });
  });

  it('throws before touching the db when the move is not permitted', async () => {
    const applyUpdate = vi.fn((): Promise<void> => Promise.resolve());
    await expect(
      reassignScope({
        config: sourceConfig,
        rowId: 'src_1',
        target: { organizationId: 'organization_1', teamId: null }, // org-wide
        ctx: memberCtx, // member < admin shareRole
        applyUpdate,
      }),
    ).rejects.toThrow(WorkspaceScopeError);
    expect(applyUpdate).not.toHaveBeenCalled();
  });
});

describe('registry', () => {
  it('throws when looking up an unregistered table', async () => {
    const { getWorkspaceResource } = await import('./kernel');
    expect(() => getWorkspaceResource(orgOnlyTable)).toThrow(/not registered/i);
  });
});
