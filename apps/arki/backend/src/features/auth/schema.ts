import { boolean, primaryKey, text, timestamp, varchar } from 'drizzle-orm/pg-core';

import { EMPTY_TWEAKS, tweaksColumn } from '@arki/auth/tweaks-column';
import { createPrefixedId } from '@arki/db/id-factory';

import { schema } from '../_schema';
import { accountIdFactory, permissionIdFactory, roleIdFactory, userIdFactory } from './ids';
import type { UserId, VerificationId } from './types';

export const userRolesEnum = schema.enum('user_roles', ['user', 'admin']);
export type UserRole = (typeof userRolesEnum.enumValues)[number];

export const userPermissionsEnum = schema.enum('user_permissions', [
  'read',
  'create',
  'update',
  'delete',
  'reply',
  'vote',
  'admin',
  'join',
  'moderate',
]);
export type UserPermission = (typeof userPermissionsEnum.enumValues)[number];

export const restrictedResourcesEnum = schema.enum('restricted_resources', [
  'collection',
  'user',
  'annotation',
  'poem',
  'workshop',
  'comment',
  'system',
  'poet',
  'reaction',
  'message',
  'list',
  'claim',
]);
export type RestrictedResource = (typeof restrictedResourcesEnum.enumValues)[number];

export const User = schema.table('users', {
  id: userIdFactory.primaryColumn(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified')
    .$defaultFn(() => false)
    .notNull(),
  image: text('image'),
  createdAt: timestamp('created_at')
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .notNull(),
  updatedAt: timestamp('updated_at')
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .notNull(),
  tweaks: tweaksColumn().notNull().default(EMPTY_TWEAKS),
});

// Export commonly used foreign key factory
export const userForeignKeys = userIdFactory.createForeignKeyFactory(() => User.id);

export const Account = schema.table('accounts', {
  id: accountIdFactory.primaryColumn(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => User.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at'),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
});

export const Session = schema.table('sessions', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createPrefixedId('sess')),
  expiresAt: timestamp('expires_at').notNull(),
  token: text('token').notNull().unique(),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id')
    .notNull()
    .$type<UserId>()
    .references(() => User.id, { onDelete: 'cascade' }),
});

export const verifications = schema.table('verifications', {
  id: text('id')
    .primaryKey()
    .$type<VerificationId>()
    .$defaultFn(() => createPrefixedId('verif')),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').$defaultFn(() => /* @__PURE__ */ new Date()),
  updatedAt: timestamp('updated_at').$defaultFn(() => /* @__PURE__ */ new Date()),
});

// Permission schema
export const Permission = schema.table('permissions', {
  id: permissionIdFactory.primaryColumn(),
  name: varchar('name', { length: 100 }).notNull().unique(),
  description: text('description'),
  resource: restrictedResourcesEnum('resource').notNull(),
  action: userPermissionsEnum('action').notNull(),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
});

// Role schema
export const Role = schema.table('roles', {
  id: roleIdFactory.primaryColumn(),
  name: varchar('name', { length: 100 }).notNull().unique(),
  description: text('description'),
  isDefault: boolean('is_default').default(false).notNull(),
  isSystem: boolean('is_system').default(false).notNull(),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
});

// Role-Permission relation schema
export const RolePermission = schema.table(
  'role_permissions',
  {
    roleId: varchar('role_id')
      .notNull()
      .references(() => Role.id, { onDelete: 'cascade' }),
    permissionId: varchar('permission_id')
      .notNull()
      .references(() => Permission.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  },
  table => [primaryKey({ columns: [table.roleId, table.permissionId] })],
);

// User-Role relation schema
export const UserRoleAssignment = schema.table(
  'user_role_assignments',
  {
    userId: varchar('user_id')
      .notNull()
      .references(() => User.id, { onDelete: 'cascade' }),
    roleId: varchar('role_id')
      .notNull()
      .references(() => Role.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  },
  table => [primaryKey({ columns: [table.userId, table.roleId] })],
);
