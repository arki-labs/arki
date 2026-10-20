import { defineId } from '@arki/contracts';

// Type-safe ID factories
const userId = defineId('u');
const roleId = defineId('r');
const permissionId = defineId('p');
const accountId = defineId('acc');

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