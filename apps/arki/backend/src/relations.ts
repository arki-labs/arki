import { defineRelations } from '@arki/db/orm';

import {
  Account,
  Permission,
  Role,
  RolePermission,
  Session,
  User,
  UserRoleAssignment,
  verifications,
} from './features/auth/schema';

const tables = {
  Account,
  Permission,
  Role,
  RolePermission,
  Session,
  User,
  UserRoleAssignment,
  verifications,
};

export const relations = defineRelations(tables, (r) => ({
  User: {
    accounts: r.many.Account({ from: r.User.id, to: r.Account.userId }),
    sessions: r.many.Session({ from: r.User.id, to: r.Session.userId }),
    userRoleAssignments: r.many.UserRoleAssignment({
      from: r.User.id,
      to: r.UserRoleAssignment.userId,
    }),
  },
  Account: {
    user: r.one.User({ from: r.Account.userId, to: r.User.id }),
  },
  Session: {
    user: r.one.User({ from: r.Session.userId, to: r.User.id }),
  },
  Permission: {
    rolePermissions: r.many.RolePermission({
      from: r.Permission.id,
      to: r.RolePermission.permissionId,
    }),
  },
  Role: {
    rolePermissions: r.many.RolePermission({
      from: r.Role.id,
      to: r.RolePermission.roleId,
    }),
    userRoleAssignments: r.many.UserRoleAssignment({
      from: r.Role.id,
      to: r.UserRoleAssignment.roleId,
    }),
  },
  RolePermission: {
    role: r.one.Role({ from: r.RolePermission.roleId, to: r.Role.id }),
    permission: r.one.Permission({
      from: r.RolePermission.permissionId,
      to: r.Permission.id,
    }),
  },
  UserRoleAssignment: {
    user: r.one.User({ from: r.UserRoleAssignment.userId, to: r.User.id }),
    role: r.one.Role({ from: r.UserRoleAssignment.roleId, to: r.Role.id }),
  },
}));

export type Relations = typeof relations;
