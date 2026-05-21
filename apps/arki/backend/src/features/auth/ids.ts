import { createIdFactory } from '@arki/db/id-factory';

import type { UserId, RoleId, PermissionId, AccountId } from './types';

// Type-safe ID factories
const userId = createIdFactory<'u', UserId>('u');
const roleId = createIdFactory<'r', RoleId>('r');
const permissionId = createIdFactory<'p', PermissionId>('p');
const accountId = createIdFactory<'acc', AccountId>('acc');

// ID Generation helper functions (backward compatibility)
export const createUserId = userId.create;
export const createRoleId = roleId.create;
export const createPermissionId = permissionId.create;
export const createAccountId = accountId.create;

// ID validation schemas (backward compatibility)
export const userIdSchema = userId.schema;
export const roleIdSchema = roleId.schema;
export const permissionIdSchema = permissionId.schema;
export const accountIdSchema = accountId.schema;

// Export ID factories for use in other features
export const userIdFactory = userId;
export const roleIdFactory = roleId;
export const permissionIdFactory = permissionId;
export const accountIdFactory = accountId;