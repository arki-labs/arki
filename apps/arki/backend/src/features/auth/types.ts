import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';

import type {
  Account,
  Permission,
  Role,
  RolePermission,
  Session,
  User,
  UserRoleAssignment,
} from './schema';

// User types
export type NewUser = InferInsertModel<typeof User>;
export type UserModel = InferSelectModel<typeof User>;
export type UpdateUser = Partial<Omit<NewUser, 'id'>>;

// Account types
export type NewAccount = InferInsertModel<typeof Account>;
export type AccountModel = InferSelectModel<typeof Account>;
export type UpdateAccount = Partial<Omit<NewAccount, 'userId' | 'provider' | 'providerAccountId'>>;

// Session types
export type NewSession = InferInsertModel<typeof Session>;
export type SessionModel = InferSelectModel<typeof Session>;
export type UpdateSession = Partial<Omit<NewSession, 'sessionToken'>>;

// Permission types
export type NewPermission = InferInsertModel<typeof Permission>;
export type PermissionModel = InferSelectModel<typeof Permission>;
export type UpdatePermission = Partial<Omit<NewPermission, 'id'>>;

// Role types
export type NewRole = InferInsertModel<typeof Role>;
export type RoleModel = InferSelectModel<typeof Role>;
export type UpdateRole = Partial<Omit<NewRole, 'id'>>;

// Role-Permission types
export type NewRolePermission = InferInsertModel<typeof RolePermission>;
export type RolePermissionModel = InferSelectModel<typeof RolePermission>;
export type UpdateRolePermission = Partial<Omit<NewRolePermission, 'roleId' | 'permissionId'>>;

// User-Role Assignment types
export type NewUserRoleAssignment = InferInsertModel<typeof UserRoleAssignment>;
export type UserRoleAssignmentModel = InferSelectModel<typeof UserRoleAssignment>;
export type UpdateUserRoleAssignment = Partial<Omit<NewUserRoleAssignment, 'userId' | 'roleId'>>;

// ID types
export type UserId = `u${string}`;
export type RoleId = `r${string}`;
export type PermissionId = `p${string}`;
export type AccountId = `acc${string}`;
export type VerificationId = `verif${string}`;

// Repository types - forward declaration to avoid circular dependency
import type { UserRepository } from './repository';
export type { UserRepository };
export type AuthRepository = UserRepository;
