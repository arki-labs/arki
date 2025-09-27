/**
 * RBAC (Role-Based Access Control) extension for better-auth
 */

import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
// import { and, eq, inArray } from 'drizzle-orm'; // TODO: Use when implementing database operations

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
export function createRBACManager(_db: NodePgDatabase<any>): DotRBACManager {
  // TODO: Implement RBAC with better-auth's database adapter
  // For now, all operations are stubbed since better-auth manages its own schema
  console.warn('RBAC manager created but database operations are not yet implemented with better-auth');

  return {
    // Role management
    async createRole(role: Omit<Role, 'id'>): Promise<Role> {
      // TODO: Implement with better-auth's database adapter
      console.warn('createRole needs implementation with better-auth database');
      const roleId = createPrefixedId('role');
      const now = new Date();

      return {
        id: roleId,
        name: role.name,
        description: role.description,
        isSystem: role.isSystem || false,
        createdAt: now,
        updatedAt: now,
      } as Role;
    },

    async updateRole(_roleId: string, updates: Partial<Role>): Promise<Role> {
      // TODO: Implement with better-auth's database adapter
      console.warn('updateRole needs implementation with better-auth database');

      return {
        id: _roleId,
        ...updates,
        updatedAt: new Date(),
      } as Role;
    },

    async deleteRole(_roleId: string): Promise<void> {
      // TODO: Implement with better-auth's database adapter
      console.warn('deleteRole needs implementation with better-auth database');
    },

    async getRole(_roleId: string): Promise<Role | null> {
      // TODO: Implement with better-auth's database adapter
      console.warn('getRole needs implementation with better-auth database');
      return null;
    },

    async getRoleByName(_name: string): Promise<Role | null> {
      // TODO: Implement with better-auth's database adapter
      console.warn('getRoleByName needs implementation with better-auth database');
      return null;
    },

    async listRoles(): Promise<Role[]> {
      // TODO: Implement with better-auth's database adapter
      console.warn('listRoles needs implementation with better-auth database');
      return [];
    },

    // User-role assignment
    async assignRole(_userId: string, _roleId: string): Promise<void> {
      // TODO: Implement with better-auth's database adapter
      console.warn('assignRole needs implementation with better-auth database');
    },

    async assignRoleByName(userId: string, roleName: string): Promise<void> {
      const role = await this.getRoleByName(roleName);
      if (!role) {
        throw new Error(`Role '${roleName}' not found`);
      }
      await this.assignRole(userId, role.id);
    },

    async removeRole(_userId: string, _roleId: string): Promise<void> {
      // TODO: Implement with better-auth's database adapter
      console.warn('removeRole needs implementation with better-auth database');
    },

    async removeRoleByName(userId: string, roleName: string): Promise<void> {
      const role = await this.getRoleByName(roleName);
      if (!role) {
        return; // Role doesn't exist, nothing to remove
      }
      await this.removeRole(userId, role.id);
    },

    async getUserRoles(_userId: string): Promise<Role[]> {
      // TODO: Implement with better-auth's database adapter
      console.warn('getUserRoles needs implementation with better-auth database');
      return [];
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
      // TODO: Implement with better-auth's database adapter
      console.warn('createPermission needs implementation with better-auth database');
      const permissionId = createPrefixedId('perm');

      return {
        id: permissionId,
        resource: permission.resource,
        action: permission.action,
        description: permission.description,
        conditions: permission.conditions,
      } as Permission;
    },

    async deletePermission(_permissionId: string): Promise<void> {
      // TODO: Implement with better-auth's database adapter
      console.warn('deletePermission needs implementation with better-auth database');
    },

    async getPermission(_permissionId: string): Promise<Permission | null> {
      // TODO: Implement with better-auth's database adapter
      console.warn('getPermission needs implementation with better-auth database');
      return null;
    },

    async listPermissions(): Promise<Permission[]> {
      // TODO: Implement with better-auth's database adapter
      console.warn('listPermissions needs implementation with better-auth database');
      return [];
    },

    // Role-permission assignment
    async assignPermissionToRole(_roleId: string, _permissionId: string): Promise<void> {
      // Check if already assigned
      // TODO: Implement with better-auth's database adapter
      // For now, stub this functionality
      console.warn('assignPermissionToRole needs implementation with better-auth database');
      const existing = null;

      if (existing) {
        return; // Already assigned
      }

      // TODO: Implement with better-auth's database adapter
      console.warn('assignPermissionToRole needs implementation with better-auth database');
    },

    async removePermissionFromRole(_roleId: string, _permissionId: string): Promise<void> {
      // TODO: Implement with better-auth's database adapter
      console.warn('removePermissionFromRole needs implementation with better-auth database');
    },

    async getRolePermissions(_roleId: string): Promise<Permission[]> {
      // TODO: Implement with better-auth's database adapter
      console.warn('getRolePermissions needs implementation with better-auth database');
      const rolePerm: any[] = [];

      if (rolePerm.length === 0) {
        return [];
      }

      // const permissionIds = rolePerm.map((rp: any) => rp.permissionId);
      // TODO: Implement with better-auth's database adapter
      const rolePermissionsList: any[] = [];

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