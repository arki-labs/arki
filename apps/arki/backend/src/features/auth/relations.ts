import { relations } from '@arki/db/orm';

import { Account, Permission, Role, RolePermission, Session, User, UserRoleAssignment } from './schema';

// User relations
export const userRelations = relations(User, ({ many }) => ({
  accounts: many(Account),
  sessions: many(Session),
  userRoleAssignments: many(UserRoleAssignment),
}));

// Account relations
export const accountRelations = relations(Account, ({ one }) => ({
  user: one(User, {
    fields: [Account.userId],
    references: [User.id],
  }),
}));

// Session relations
export const sessionRelations = relations(Session, ({ one }) => ({
  user: one(User, {
    fields: [Session.userId],
    references: [User.id],
  }),
}));

// Permission relations
export const permissionRelations = relations(Permission, ({ many }) => ({
  rolePermissions: many(RolePermission),
}));

// Role relations
export const roleRelations = relations(Role, ({ many }) => ({
  rolePermissions: many(RolePermission),
  userRoleAssignments: many(UserRoleAssignment),
}));

// RolePermission relations
export const rolePermissionRelations = relations(RolePermission, ({ one }) => ({
  role: one(Role, {
    fields: [RolePermission.roleId],
    references: [Role.id],
  }),
  permission: one(Permission, {
    fields: [RolePermission.permissionId],
    references: [Permission.id],
  }),
}));

// UserRoleAssignment relations
export const userRoleAssignmentRelations = relations(UserRoleAssignment, ({ one }) => ({
  user: one(User, {
    fields: [UserRoleAssignment.userId],
    references: [User.id],
  }),
  role: one(Role, {
    fields: [UserRoleAssignment.roleId],
    references: [Role.id],
  }),
}));
