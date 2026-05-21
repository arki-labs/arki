/**
 * RBAC (Role-Based Access Control) extension for better-auth
 */

import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

// import { and, eq, inArray } from 'drizzle-orm'; // TODO: Use when implementing database operations

import { createPrefixedId } from '@arki/db/id';

import type { DotUser, Permission, PolicyContext, Role } from './types.js';
import { debugAuth } from '../debug.js';

/**
 * RBAC manager interface
 */
export type DotRBACManager = {
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
  hasAnyPermission(userId: string, permissions: { resource: string; action: string }[]): Promise<boolean>;
  hasAllPermissions(userId: string, permissions: { resource: string; action: string }[]): Promise<boolean>;

  // Policy evaluation (for ABAC)
  evaluatePolicy(context: PolicyContext): Promise<boolean>;

  // Utility methods
  syncUserRoles(userId: string, roleNames: string[]): Promise<void>;
  getUserWithRolesAndPermissions(userId: string): Promise<DotUser | null>;
};

/**
 * Create RBAC manager
 */
export function createRBACManager(_db: NodePgDatabase<any>): DotRBACManager {
  debugAuth('[rbac] Creating RBAC manager');
  // TODO: Implement RBAC with better-auth's database adapter
  // For now, all operations are stubbed since better-auth manages its own schema
  console.warn('RBAC manager created but database operations are not yet implemented with better-auth');
  debugAuth('[rbac] RBAC manager created (database operations pending better-auth implementation)');

  return {
    // Role management
    async createRole(role: Omit<Role, 'id'>): Promise<Role> {
      debugAuth('[rbac] Creating role (name: %s, isSystem: %s)', role.name, role.isSystem || false);
      // TODO: Implement with better-auth's database adapter
      console.warn('createRole needs implementation with better-auth database');
      const roleId = createPrefixedId('role');
      const now = new Date();

      debugAuth('[rbac] Role created (id: %s, name: %s)', roleId, role.name);
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
      debugAuth('[rbac] Updating role (id: %s)', _roleId);
      // TODO: Implement with better-auth's database adapter
      console.warn('updateRole needs implementation with better-auth database');

      debugAuth('[rbac] Role updated (id: %s)', _roleId);
      return {
        id: _roleId,
        ...updates,
        updatedAt: new Date(),
      } as Role;
    },

    async deleteRole(_roleId: string): Promise<void> {
      debugAuth('[rbac] Deleting role (id: %s)', _roleId);
      // TODO: Implement with better-auth's database adapter
      console.warn('deleteRole needs implementation with better-auth database');
      debugAuth('[rbac] Role deleted (id: %s)', _roleId);
    },

    async getRole(_roleId: string): Promise<Role | null> {
      debugAuth('[rbac] Getting role by ID (id: %s)', _roleId);
      // TODO: Implement with better-auth's database adapter
      console.warn('getRole needs implementation with better-auth database');
      debugAuth('[rbac] Role not found (id: %s)', _roleId);
      return null;
    },

    async getRoleByName(_name: string): Promise<Role | null> {
      debugAuth('[rbac] Getting role by name (name: %s)', _name);
      // TODO: Implement with better-auth's database adapter
      console.warn('getRoleByName needs implementation with better-auth database');
      debugAuth('[rbac] Role not found (name: %s)', _name);
      return null;
    },

    async listRoles(): Promise<Role[]> {
      debugAuth('[rbac] Listing all roles');
      // TODO: Implement with better-auth's database adapter
      console.warn('listRoles needs implementation with better-auth database');
      debugAuth('[rbac] Listed 0 roles');
      return [];
    },

    // User-role assignment
    async assignRole(_userId: string, _roleId: string): Promise<void> {
      debugAuth('[rbac] Assigning role to user (userId: %s, roleId: %s)', _userId, _roleId);
      // TODO: Implement with better-auth's database adapter
      console.warn('assignRole needs implementation with better-auth database');
      debugAuth('[rbac] Role assigned to user (userId: %s, roleId: %s)', _userId, _roleId);
    },

    async assignRoleByName(userId: string, roleName: string): Promise<void> {
      debugAuth('[rbac] Assigning role to user by name (userId: %s, roleName: %s)', userId, roleName);
      const role = await this.getRoleByName(roleName);
      if (!role) {
        debugAuth('[rbac] Role assignment failed: role not found (roleName: %s)', roleName);
        throw new Error(`Role '${roleName}' not found`);
      }
      await this.assignRole(userId, role.id);
      debugAuth('[rbac] Role assigned by name (userId: %s, roleName: %s)', userId, roleName);
    },

    async removeRole(_userId: string, _roleId: string): Promise<void> {
      debugAuth('[rbac] Removing role from user (userId: %s, roleId: %s)', _userId, _roleId);
      // TODO: Implement with better-auth's database adapter
      console.warn('removeRole needs implementation with better-auth database');
      debugAuth('[rbac] Role removed from user (userId: %s, roleId: %s)', _userId, _roleId);
    },

    async removeRoleByName(userId: string, roleName: string): Promise<void> {
      debugAuth('[rbac] Removing role from user by name (userId: %s, roleName: %s)', userId, roleName);
      const role = await this.getRoleByName(roleName);
      if (!role) {
        debugAuth('[rbac] Role removal skipped: role not found (roleName: %s)', roleName);
        return; // Role doesn't exist, nothing to remove
      }
      await this.removeRole(userId, role.id);
      debugAuth('[rbac] Role removed by name (userId: %s, roleName: %s)', userId, roleName);
    },

    async getUserRoles(_userId: string): Promise<Role[]> {
      debugAuth('[rbac] Getting user roles (userId: %s)', _userId);
      // TODO: Implement with better-auth's database adapter
      console.warn('getUserRoles needs implementation with better-auth database');
      debugAuth('[rbac] User has 0 roles (userId: %s)', _userId);
      return [];
    },

    async getUserRoleNames(userId: string): Promise<string[]> {
      debugAuth('[rbac] Getting user role names (userId: %s)', userId);
      const userRolesList = await this.getUserRoles(userId);
      const roleNames = userRolesList.map(role => role.name);
      debugAuth('[rbac] User role names: %s (userId: %s)', roleNames.join(', ') || 'none', userId);
      return roleNames;
    },

    async hasRole(userId: string, roleName: string): Promise<boolean> {
      debugAuth('[rbac] Checking if user has role (userId: %s, roleName: %s)', userId, roleName);
      const userRoleNames = await this.getUserRoleNames(userId);
      const hasIt = userRoleNames.includes(roleName);
      debugAuth('[rbac] User %s role (userId: %s, roleName: %s)', hasIt ? 'has' : 'does not have', userId, roleName);
      return hasIt;
    },

    // Permission management
    async createPermission(permission: Omit<Permission, 'id'>): Promise<Permission> {
      debugAuth('[rbac] Creating permission (resource: %s, action: %s)', permission.resource, permission.action);
      // TODO: Implement with better-auth's database adapter
      console.warn('createPermission needs implementation with better-auth database');
      const permissionId = createPrefixedId('perm');

      debugAuth(
        '[rbac] Permission created (id: %s, resource: %s, action: %s)',
        permissionId,
        permission.resource,
        permission.action,
      );
      return {
        id: permissionId,
        resource: permission.resource,
        action: permission.action,
        description: permission.description,
        conditions: permission.conditions,
      } as Permission;
    },

    async deletePermission(_permissionId: string): Promise<void> {
      debugAuth('[rbac] Deleting permission (id: %s)', _permissionId);
      // TODO: Implement with better-auth's database adapter
      console.warn('deletePermission needs implementation with better-auth database');
      debugAuth('[rbac] Permission deleted (id: %s)', _permissionId);
    },

    async getPermission(_permissionId: string): Promise<Permission | null> {
      debugAuth('[rbac] Getting permission (id: %s)', _permissionId);
      // TODO: Implement with better-auth's database adapter
      console.warn('getPermission needs implementation with better-auth database');
      debugAuth('[rbac] Permission not found (id: %s)', _permissionId);
      return null;
    },

    async listPermissions(): Promise<Permission[]> {
      debugAuth('[rbac] Listing all permissions');
      // TODO: Implement with better-auth's database adapter
      console.warn('listPermissions needs implementation with better-auth database');
      debugAuth('[rbac] Listed 0 permissions');
      return [];
    },

    // Role-permission assignment
    async assignPermissionToRole(_roleId: string, _permissionId: string): Promise<void> {
      debugAuth('[rbac] Assigning permission to role (roleId: %s, permissionId: %s)', _roleId, _permissionId);
      // Check if already assigned
      // TODO: Implement with better-auth's database adapter
      // For now, stub this functionality
      console.warn('assignPermissionToRole needs implementation with better-auth database');
      const existing = null;

      if (existing) {
        debugAuth('[rbac] Permission already assigned to role (roleId: %s, permissionId: %s)', _roleId, _permissionId);
        return; // Already assigned
      }

      // TODO: Implement with better-auth's database adapter
      console.warn('assignPermissionToRole needs implementation with better-auth database');
      debugAuth('[rbac] Permission assigned to role (roleId: %s, permissionId: %s)', _roleId, _permissionId);
    },

    async removePermissionFromRole(_roleId: string, _permissionId: string): Promise<void> {
      debugAuth('[rbac] Removing permission from role (roleId: %s, permissionId: %s)', _roleId, _permissionId);
      // TODO: Implement with better-auth's database adapter
      console.warn('removePermissionFromRole needs implementation with better-auth database');
      debugAuth('[rbac] Permission removed from role (roleId: %s, permissionId: %s)', _roleId, _permissionId);
    },

    async getRolePermissions(_roleId: string): Promise<Permission[]> {
      debugAuth('[rbac] Getting role permissions (roleId: %s)', _roleId);
      // TODO: Implement with better-auth's database adapter
      console.warn('getRolePermissions needs implementation with better-auth database');
      const rolePerm: any[] = [];

      if (rolePerm.length === 0) {
        debugAuth('[rbac] Role has 0 permissions (roleId: %s)', _roleId);
        return [];
      }

      // const permissionIds = rolePerm.map((rp: any) => rp.permissionId);
      // TODO: Implement with better-auth's database adapter
      const rolePermissionsList: any[] = [];

      debugAuth('[rbac] Role has %d permission(s) (roleId: %s)', rolePermissionsList.length, _roleId);
      return rolePermissionsList.map((p: any) => ({
        ...p,
        conditions: p.conditions ? JSON.parse(p.conditions) : undefined,
      })) as Permission[];
    },

    // User permission checking
    async getUserPermissions(userId: string): Promise<Permission[]> {
      debugAuth('[rbac] Getting user permissions (userId: %s)', userId);
      const userRolesList = await this.getUserRoles(userId);
      if (userRolesList.length === 0) {
        debugAuth('[rbac] User has no roles, returning 0 permissions (userId: %s)', userId);
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

      debugAuth('[rbac] User has %d unique permission(s) (userId: %s)', allPermissions.length, userId);
      return allPermissions;
    },

    async hasPermission(userId: string, resource: string, action: string): Promise<boolean> {
      debugAuth('[rbac] Checking user permission (userId: %s, resource: %s, action: %s)', userId, resource, action);
      const userPermissions = await this.getUserPermissions(userId);
      const hasIt = userPermissions.some(p => p.resource === resource && p.action === action);
      debugAuth(
        '[rbac] User %s permission (userId: %s, resource: %s, action: %s)',
        hasIt ? 'has' : 'lacks',
        userId,
        resource,
        action,
      );
      return hasIt;
    },

    async hasAnyPermission(userId: string, permissions: { resource: string; action: string }[]): Promise<boolean> {
      debugAuth('[rbac] Checking if user has any of %d permission(s) (userId: %s)', permissions.length, userId);
      const userPermissions = await this.getUserPermissions(userId);

      for (const required of permissions) {
        const hasIt = userPermissions.some(p => p.resource === required.resource && p.action === required.action);
        if (hasIt) {
          debugAuth('[rbac] User has at least one required permission (userId: %s)', userId);
          return true;
        }
      }

      debugAuth('[rbac] User lacks all required permissions (userId: %s)', userId);
      return false;
    },

    async hasAllPermissions(userId: string, permissions: { resource: string; action: string }[]): Promise<boolean> {
      debugAuth('[rbac] Checking if user has all %d permission(s) (userId: %s)', permissions.length, userId);
      const userPermissions = await this.getUserPermissions(userId);

      for (const required of permissions) {
        const hasIt = userPermissions.some(p => p.resource === required.resource && p.action === required.action);
        if (!hasIt) {
          debugAuth(
            '[rbac] User lacks required permission (userId: %s, resource: %s, action: %s)',
            userId,
            required.resource,
            required.action,
          );
          return false;
        }
      }

      debugAuth('[rbac] User has all required permissions (userId: %s)', userId);
      return true;
    },

    // Policy evaluation (for ABAC)
    async evaluatePolicy(context: PolicyContext): Promise<boolean> {
      debugAuth(
        '[rbac] Evaluating policy (userId: %s, resource: %s, action: %s)',
        context.user.id,
        context.resource,
        context.action,
      );
      // First check RBAC
      const hasPermission = await this.hasPermission(context.user.id, context.resource, context.action);

      if (hasPermission) {
        // If user has permission through roles, check conditions if any
        const userPermissions = await this.getUserPermissions(context.user.id);
        const relevantPermission = userPermissions.find(
          p => p.resource === context.resource && p.action === context.action,
        );

        if (relevantPermission?.conditions) {
          debugAuth(
            '[rbac] Evaluating permission conditions (userId: %s, resource: %s, action: %s)',
            context.user.id,
            context.resource,
            context.action,
          );
          // Evaluate conditions (simplified example)
          // In a real implementation, you'd have a proper policy engine
          const conditionsPass = evaluateConditions(relevantPermission.conditions, context);
          debugAuth('[rbac] Policy evaluation %s (userId: %s)', conditionsPass ? 'passed' : 'failed', context.user.id);
          return conditionsPass;
        }

        debugAuth('[rbac] Policy evaluation passed (no conditions) (userId: %s)', context.user.id);
        return true;
      }

      debugAuth('[rbac] Policy evaluation failed: no permission (userId: %s)', context.user.id);
      return false;
    },

    // Utility methods
    async syncUserRoles(userId: string, roleNames: string[]): Promise<void> {
      debugAuth('[rbac] Syncing user roles (userId: %s, targetRoles: %s)', userId, roleNames.join(', '));
      // Get current roles
      const currentRoles = await this.getUserRoleNames(userId);

      // Determine roles to add and remove
      const rolesToAdd = roleNames.filter(r => !currentRoles.includes(r));
      const rolesToRemove = currentRoles.filter(r => !roleNames.includes(r));

      debugAuth(
        '[rbac] Role sync plan (userId: %s, toAdd: %d, toRemove: %d)',
        userId,
        rolesToAdd.length,
        rolesToRemove.length,
      );

      // Add new roles
      for (const roleName of rolesToAdd) {
        await this.assignRoleByName(userId, roleName);
      }

      // Remove old roles
      for (const roleName of rolesToRemove) {
        await this.removeRoleByName(userId, roleName);
      }

      debugAuth('[rbac] User roles synced (userId: %s)', userId);
    },

    async getUserWithRolesAndPermissions(userId: string): Promise<DotUser | null> {
      debugAuth('[rbac] Getting user with roles and permissions (userId: %s)', userId);
      // Since we don't have direct access to better-auth's tables,
      // we need to use the API or return a simplified version
      // This is a placeholder that should be implemented with better-auth's API

      // For now, return null as we can't directly query better-auth's database
      // In a real implementation, this would use better-auth's API
      console.warn('getUserWithRolesAndPermissions needs to be implemented with better-auth API');

      const userRolesList = await this.getUserRoles(userId);
      const userPermissions = await this.getUserPermissions(userId);

      debugAuth(
        '[rbac] User loaded with %d role(s) and %d permission(s) (userId: %s)',
        userRolesList.length,
        userPermissions.length,
        userId,
      );

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
  debugAuth('[rbac] Evaluating %d condition(s)', Object.keys(conditions).length);
  for (const [key, value] of Object.entries(conditions)) {
    switch (key) {
      case 'environment': {
        debugAuth('[rbac] Checking environment conditions');
        if (context.environment) {
          for (const [envKey, envValue] of Object.entries(value)) {
            if (context.environment[envKey] !== envValue) {
              debugAuth(
                '[rbac] Environment condition failed (key: %s, expected: %s, actual: %s)',
                envKey,
                envValue,
                context.environment[envKey],
              );
              return false;
            }
          }
        }
        break;
      }
      case 'attributes': {
        debugAuth('[rbac] Checking attribute conditions');
        if (context.attributes) {
          for (const [attrKey, attrValue] of Object.entries(value)) {
            if (context.attributes[attrKey] !== attrValue) {
              debugAuth(
                '[rbac] Attribute condition failed (key: %s, expected: %s, actual: %s)',
                attrKey,
                attrValue,
                context.attributes[attrKey],
              );
              return false;
            }
          }
        }
        break;
      }
      // Add more condition types as needed
    }
  }

  debugAuth('[rbac] All conditions passed');
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
    permissions: [{ resource: '*', action: '*' }],
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
  debugAuth('[rbac] Initializing RBAC with %d default role(s)', defaultRoles.length);
  for (const roleData of defaultRoles) {
    // Check if role exists
    debugAuth('[rbac] Checking for existing role (name: %s)', roleData.name);
    const existingRole = await rbac.getRoleByName(roleData.name);

    if (existingRole) {
      debugAuth('[rbac] Default role already exists (name: %s)', roleData.name);
    } else {
      debugAuth(
        '[rbac] Creating new default role (name: %s, permissions: %d)',
        roleData.name,
        roleData.permissions.length,
      );
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
      debugAuth('[rbac] Default role initialized (name: %s, id: %s)', roleData.name, role.id);
    }
  }
  debugAuth('[rbac] RBAC initialization complete');
}
