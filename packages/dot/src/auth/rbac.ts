/**
 * RBAC (Role-Based Access Control) extension for better-auth
 */

import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, eq, inArray } from 'drizzle-orm';

import { createPrefixedId } from '@arki/db/id';

import type { DotUser, Permission, PolicyContext, Role } from './types';

/**
 * RBAC manager interface
 */
export interface DotRBACManager {
  // Role management
  createRole(role: Omit<Role, 'id'>): Promise<Role>;
  updateRole(roleId: string, updates: Partial<Role>): Promise<Role>;
  deleteRole(roleId: string): Promise<void>;
  getRole(roleId: string): Promise<Role | null>;
  getRoleByName(name: string): Promise<Role | null>;
  listRoles(): Promise<Role[]>;

  // User-role assignment
  assignRole(userId: string, roleId: string): Promise<void>;
  assignRoleByName(userId: string, roleName: string): Promise<void>;
  removeRole(userId: string, roleId: string): Promise<void>;
  removeRoleByName(userId: string, roleName: string): Promise<void>;
  getUserRoles(userId: string): Promise<Role[]>;
  getUserRoleNames(userId: string): Promise<string[]>;
  hasRole(userId: string, roleName: string): Promise<boolean>;

  // Permission management
  createPermission(permission: Omit<Permission, 'id'>): Promise<Permission>;
  deletePermission(permissionId: string): Promise<void>;
  getPermission(permissionId: string): Promise<Permission | null>;
  listPermissions(): Promise<Permission[]>;

  // Role-permission assignment
  assignPermissionToRole(roleId: string, permissionId: string): Promise<void>;
  removePermissionFromRole(roleId: string, permissionId: string): Promise<void>;
  getRolePermissions(roleId: string): Promise<Permission[]>;

  // User permission checking
  getUserPermissions(userId: string): Promise<Permission[]>;
  hasPermission(userId: string, resource: string, action: string): Promise<boolean>;
  hasAnyPermission(userId: string, permissions: Array<{ resource: string; action: string }>): Promise<boolean>;
  hasAllPermissions(userId: string, permissions: Array<{ resource: string; action: string }>): Promise<boolean>;

  // Policy evaluation (for ABAC)
  evaluatePolicy(context: PolicyContext): Promise<boolean>;

  // Utility methods
  syncUserRoles(userId: string, roleNames: string[]): Promise<void>;
  getUserWithRolesAndPermissions(userId: string): Promise<DotUser | null>;
}

/**
 * Create RBAC manager
 */
export function createRBACManager(db: NodePgDatabase<any>): DotRBACManager {
  // Table references (these would be defined in your schema)
  const roles = 'roles';
  const permissions = 'permissions';
  const userRoles = 'user_roles';
  const rolePermissions = 'role_permissions';
  const users = 'users';

  return {
    // Role management
    async createRole(role: Omit<Role, 'id'>): Promise<Role> {
      const roleId = createPrefixedId('role');
      const now = new Date();

      const [newRole] = await db
        .insert(roles)
        .values({
          id: roleId,
          name: role.name,
          description: role.description,
          isSystem: role.isSystem || false,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      return newRole as Role;
    },

    async updateRole(roleId: string, updates: Partial<Role>): Promise<Role> {
      const [updated] = await db
        .update(roles)
        .set({
          ...updates,
          updatedAt: new Date(),
        })
        .where(eq('id', roleId))
        .returning();

      return updated as Role;
    },

    async deleteRole(roleId: string): Promise<void> {
      // Check if it's a system role
      const [role] = await db
        .select()
        .from(roles)
        .where(eq('id', roleId))
        .limit(1);

      if (role?.isSystem) {
        throw new Error('Cannot delete system role');
      }

      // Delete role and cascade to user_roles and role_permissions
      await db.delete(userRoles).where(eq('roleId', roleId));
      await db.delete(rolePermissions).where(eq('roleId', roleId));
      await db.delete(roles).where(eq('id', roleId));
    },

    async getRole(roleId: string): Promise<Role | null> {
      const [role] = await db
        .select()
        .from(roles)
        .where(eq('id', roleId))
        .limit(1);

      return role as Role | null;
    },

    async getRoleByName(name: string): Promise<Role | null> {
      const [role] = await db
        .select()
        .from(roles)
        .where(eq('name', name))
        .limit(1);

      return role as Role | null;
    },

    async listRoles(): Promise<Role[]> {
      const allRoles = await db
        .select()
        .from(roles)
        .orderBy('name');

      return allRoles as Role[];
    },

    // User-role assignment
    async assignRole(userId: string, roleId: string): Promise<void> {
      // Check if already assigned
      const [existing] = await db
        .select()
        .from(userRoles)
        .where(and(eq('userId', userId), eq('roleId', roleId)))
        .limit(1);

      if (existing) {
        return; // Already assigned
      }

      await db.insert(userRoles).values({
        userId,
        roleId,
        assignedAt: new Date(),
      });
    },

    async assignRoleByName(userId: string, roleName: string): Promise<void> {
      const role = await this.getRoleByName(roleName);
      if (!role) {
        throw new Error(`Role '${roleName}' not found`);
      }
      await this.assignRole(userId, role.id);
    },

    async removeRole(userId: string, roleId: string): Promise<void> {
      await db
        .delete(userRoles)
        .where(and(eq('userId', userId), eq('roleId', roleId)));
    },

    async removeRoleByName(userId: string, roleName: string): Promise<void> {
      const role = await this.getRoleByName(roleName);
      if (!role) {
        return; // Role doesn't exist, nothing to remove
      }
      await this.removeRole(userId, role.id);
    },

    async getUserRoles(userId: string): Promise<Role[]> {
      const userRoleRecords = await db
        .select()
        .from(userRoles)
        .where(eq('userId', userId));

      if (userRoleRecords.length === 0) {
        return [];
      }

      const roleIds = userRoleRecords.map((ur: any) => ur.roleId);
      const userRolesList = await db
        .select()
        .from(roles)
        .where(inArray('id', roleIds));

      return userRolesList as Role[];
    },

    async getUserRoleNames(userId: string): Promise<string[]> {
      const userRolesList = await this.getUserRoles(userId);
      return userRolesList.map(role => role.name);
    },

    async hasRole(userId: string, roleName: string): Promise<boolean> {
      const userRoleNames = await this.getUserRoleNames(userId);
      return userRoleNames.includes(roleName);
    },

    // Permission management
    async createPermission(permission: Omit<Permission, 'id'>): Promise<Permission> {
      const permissionId = createPrefixedId('perm');

      const [newPermission] = await db
        .insert(permissions)
        .values({
          id: permissionId,
          resource: permission.resource,
          action: permission.action,
          description: permission.description,
          conditions: permission.conditions ? JSON.stringify(permission.conditions) : null,
        })
        .returning();

      return newPermission as Permission;
    },

    async deletePermission(permissionId: string): Promise<void> {
      // Delete from role_permissions first
      await db.delete(rolePermissions).where(eq('permissionId', permissionId));
      await db.delete(permissions).where(eq('id', permissionId));
    },

    async getPermission(permissionId: string): Promise<Permission | null> {
      const [permission] = await db
        .select()
        .from(permissions)
        .where(eq('id', permissionId))
        .limit(1);

      if (!permission) return null;

      return {
        ...permission,
        conditions: permission.conditions ? JSON.parse(permission.conditions as string) : undefined,
      } as Permission;
    },

    async listPermissions(): Promise<Permission[]> {
      const allPermissions = await db
        .select()
        .from(permissions)
        .orderBy('resource', 'action');

      return allPermissions.map((p: any) => ({
        ...p,
        conditions: p.conditions ? JSON.parse(p.conditions) : undefined,
      })) as Permission[];
    },

    // Role-permission assignment
    async assignPermissionToRole(roleId: string, permissionId: string): Promise<void> {
      // Check if already assigned
      const [existing] = await db
        .select()
        .from(rolePermissions)
        .where(and(eq('roleId', roleId), eq('permissionId', permissionId)))
        .limit(1);

      if (existing) {
        return; // Already assigned
      }

      await db.insert(rolePermissions).values({
        roleId,
        permissionId,
      });
    },

    async removePermissionFromRole(roleId: string, permissionId: string): Promise<void> {
      await db
        .delete(rolePermissions)
        .where(and(eq('roleId', roleId), eq('permissionId', permissionId)));
    },

    async getRolePermissions(roleId: string): Promise<Permission[]> {
      const rolePerm = await db
        .select()
        .from(rolePermissions)
        .where(eq('roleId', roleId));

      if (rolePerm.length === 0) {
        return [];
      }

      const permissionIds = rolePerm.map((rp: any) => rp.permissionId);
      const rolePermissionsList = await db
        .select()
        .from(permissions)
        .where(inArray('id', permissionIds));

      return rolePermissionsList.map((p: any) => ({
        ...p,
        conditions: p.conditions ? JSON.parse(p.conditions) : undefined,
      })) as Permission[];
    },

    // User permission checking
    async getUserPermissions(userId: string): Promise<Permission[]> {
      const userRolesList = await this.getUserRoles(userId);
      if (userRolesList.length === 0) {
        return [];
      }

      const allPermissions: Permission[] = [];
      const seenPermissions = new Set<string>();

      for (const role of userRolesList) {
        const rolePerms = await this.getRolePermissions(role.id);
        for (const perm of rolePerms) {
          const key = `${perm.resource}:${perm.action}`;
          if (!seenPermissions.has(key)) {
            seenPermissions.add(key);
            allPermissions.push(perm);
          }
        }
      }

      return allPermissions;
    },

    async hasPermission(userId: string, resource: string, action: string): Promise<boolean> {
      const userPermissions = await this.getUserPermissions(userId);
      return userPermissions.some(p => p.resource === resource && p.action === action);
    },

    async hasAnyPermission(
      userId: string,
      permissions: Array<{ resource: string; action: string }>
    ): Promise<boolean> {
      const userPermissions = await this.getUserPermissions(userId);

      for (const required of permissions) {
        const hasIt = userPermissions.some(
          p => p.resource === required.resource && p.action === required.action
        );
        if (hasIt) return true;
      }

      return false;
    },

    async hasAllPermissions(
      userId: string,
      permissions: Array<{ resource: string; action: string }>
    ): Promise<boolean> {
      const userPermissions = await this.getUserPermissions(userId);

      for (const required of permissions) {
        const hasIt = userPermissions.some(
          p => p.resource === required.resource && p.action === required.action
        );
        if (!hasIt) return false;
      }

      return true;
    },

    // Policy evaluation (for ABAC)
    async evaluatePolicy(context: PolicyContext): Promise<boolean> {
      // First check RBAC
      const hasPermission = await this.hasPermission(
        context.user.id!,
        context.resource,
        context.action
      );

      if (hasPermission) {
        // If user has permission through roles, check conditions if any
        const userPermissions = await this.getUserPermissions(context.user.id!);
        const relevantPermission = userPermissions.find(
          p => p.resource === context.resource && p.action === context.action
        );

        if (relevantPermission?.conditions) {
          // Evaluate conditions (simplified example)
          // In a real implementation, you'd have a proper policy engine
          return evaluateConditions(relevantPermission.conditions, context);
        }

        return true;
      }

      return false;
    },

    // Utility methods
    async syncUserRoles(userId: string, roleNames: string[]): Promise<void> {
      // Get current roles
      const currentRoles = await this.getUserRoleNames(userId);

      // Determine roles to add and remove
      const rolesToAdd = roleNames.filter(r => !currentRoles.includes(r));
      const rolesToRemove = currentRoles.filter(r => !roleNames.includes(r));

      // Add new roles
      for (const roleName of rolesToAdd) {
        await this.assignRoleByName(userId, roleName);
      }

      // Remove old roles
      for (const roleName of rolesToRemove) {
        await this.removeRoleByName(userId, roleName);
      }
    },

    async getUserWithRolesAndPermissions(userId: string): Promise<DotUser | null> {
      // Since we don't have direct access to better-auth's tables,
      // we need to use the API or return a simplified version
      // This is a placeholder that should be implemented with better-auth's API

      // For now, return null as we can't directly query better-auth's database
      // In a real implementation, this would use better-auth's API
      console.warn('getUserWithRolesAndPermissions needs to be implemented with better-auth API');

      const userRolesList = await this.getUserRoles(userId);
      const userPermissions = await this.getUserPermissions(userId);

      // For now, return a minimal user object
      // In production, this should integrate with better-auth's user system
      return {
        id: userId,
        roles: userRolesList,
        permissions: userPermissions,
      } as DotUser;
    },
  };
}

/**
 * Simple condition evaluator (example implementation)
 */
function evaluateConditions(conditions: Record<string, any>, context: PolicyContext): boolean {
  for (const [key, value] of Object.entries(conditions)) {
    switch (key) {
      case 'environment':
        if (context.environment) {
          for (const [envKey, envValue] of Object.entries(value)) {
            if (context.environment[envKey] !== envValue) {
              return false;
            }
          }
        }
        break;
      case 'attributes':
        if (context.attributes) {
          for (const [attrKey, attrValue] of Object.entries(value)) {
            if (context.attributes[attrKey] !== attrValue) {
              return false;
            }
          }
        }
        break;
      // Add more condition types as needed
    }
  }

  return true;
}

/**
 * Default roles and permissions
 */
export const defaultRoles = [
  {
    name: 'admin',
    description: 'Administrator with full access',
    isSystem: true,
    permissions: [
      { resource: '*', action: '*' },
    ],
  },
  {
    name: 'moderator',
    description: 'Moderator with limited admin access',
    isSystem: true,
    permissions: [
      { resource: 'users', action: 'read' },
      { resource: 'users', action: 'update' },
      { resource: 'content', action: '*' },
    ],
  },
  {
    name: 'user',
    description: 'Regular user',
    isSystem: true,
    permissions: [
      { resource: 'profile', action: 'read' },
      { resource: 'profile', action: 'update' },
    ],
  },
];

/**
 * Initialize default roles and permissions
 */
export async function initializeRBAC(rbac: DotRBACManager): Promise<void> {
  for (const roleData of defaultRoles) {
    // Check if role exists
    const existingRole = await rbac.getRoleByName(roleData.name);

    if (!existingRole) {
      // Create role
      const role = await rbac.createRole({
        name: roleData.name,
        description: roleData.description,
        isSystem: roleData.isSystem,
      });

      // Create and assign permissions
      for (const permData of roleData.permissions) {
        const permission = await rbac.createPermission(permData);
        await rbac.assignPermissionToRole(role.id, permission.id);
      }
    }
  }
}