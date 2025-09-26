import { createIdFactory } from '@arki/db/id-factory';

// ID types
export type UserId = `usr_${string}`;
export type UserVerificationId = `verif_${string}`;
export type SessionId = `sess_${string}`;
export type RoleId = `role_${string}`;
export type PermissionId = `perm_${string}`;
export type AccountId = `acc_${string}`;
export type VerificationId = `verif_${string}`;

// Type-safe ID factories
const userId = createIdFactory<'usr_', UserId>('usr_');
const userVerificationId = createIdFactory<'verif_', UserVerificationId>('verif_');
const sessionId = createIdFactory<'sess_', SessionId>('sess_');
const roleId = createIdFactory<'role_', RoleId>('role_');
const permissionId = createIdFactory<'perm_', PermissionId>('perm_');
const accountId = createIdFactory<'acc_', AccountId>('acc_');

// ID Generation helper functions (backward compatibility)
export const createUserId = userId.create;
export const createUserVerificationId = userVerificationId.create;
export const createSessionId = sessionId.create;
export const createRoleId = roleId.create;
export const createPermissionId = permissionId.create;
export const createAccountId = accountId.create;

// ID validation schemas (backward compatibility)
export const userIdSchema = userId.schema;
export const userVerificationIdSchema = userVerificationId.schema;
export const sessionIdSchema = sessionId.schema;
export const roleIdSchema = roleId.schema;
export const permissionIdSchema = permissionId.schema;
export const accountIdSchema = accountId.schema;

// Export ID factories for use in other features
export const userIdFactory = userId;
export const userVerificationIdFactory = userVerificationId;
export const sessionIdFactory = sessionId;
export const roleIdFactory = roleId;
export const permissionIdFactory = permissionId;
export const accountIdFactory = accountId;
