import { and, eq, inArray } from 'drizzle-orm';

import type { Database } from '../../db';
import type { RestrictedResource, UserPermission } from './schema';
import { Permission, Role, RolePermission, User, UserRoleAssignment } from './schema';
import type {
  NewPermission,
  NewRole,
  NewUser,
  PermissionId,
  PermissionModel,
  RoleId,
  UpdatePermission,
  UpdateRole,
  UpdateUser,
  UserId,
} from './types';

/**
 * Repository for User-related database operations
 */
export class UserRepository {
  constructor(private readonly db: Database) {}

  /**
   * Find a user by ID
   */
  async findById(id: UserId) {
    // Check if the query object is properly initialized
    if (!this.db.query.User) {
      throw new Error('Database query not properly initialized');
    }

    return this.db.query.User.findFirst({
      where: eq(User.id, id),
      with: {
        accounts: true,
      },
    });
  }

  /**
   * Find a user by email
   */
  async findByEmail(email: string) {
    // Check if the query object is properly initialized
    if (!this.db.query.User) {
      throw new Error('Database query not properly initialized');
    }

    return this.db.query.User.findFirst({
      where: eq(User.email, email),
    });
  }

  /**
   * Create a new user
   */
  async create(data: NewUser) {
    const [user] = await this.db.insert(User).values(data).returning();
    return user;
  }

  /**
   * Update a user
   */
  async update(id: UserId, data: UpdateUser) {
    const [user] = await this.db.update(User).set(data).where(eq(User.id, id)).returning();
    return user;
  }

  /**
   * Delete a user
   */
  async delete(id: UserId) {
    await this.db.delete(User).where(eq(User.id, id));
    return { success: true };
  }

  /**
   * Create a new role
   */
  async createRole(data: NewRole) {
    const [role] = await this.db.insert(Role).values(data).returning();
    return role;
  }

  /**
   * Update an existing role
   */
  async updateRole(id: RoleId, data: UpdateRole) {
    const [role] = await this.db
      .update(Role)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(Role.id, id))
      .returning();
    return role;
  }

  /**
   * Delete a role
   */
  async deleteRole(id: RoleId) {
    await this.db.delete(Role).where(eq(Role.id, id));
  }

  /**
   * Find a role by ID
   */
  async findRoleById(id: RoleId) {
    return this.db.query.Role.findFirst({
      where: eq(Role.id, id),
    });
  }

  /**
   * Find a role by name
   */
  async findRoleByName(name: string) {
    return this.db.query.Role.findFirst({
      where: eq(Role.name, name),
    });
  }

  /**
   * Get all roles
   */
  async getAllRoles() {
    return this.db.query.Role.findMany();
  }

  /**
   * Create a new permission
   */
  async createPermission(data: NewPermission) {
    const [permission] = await this.db.insert(Permission).values(data).returning();
    return permission;
  }

  /**
   * Update an existing permission
   */
  async updatePermission(id: PermissionId, data: UpdatePermission) {
    const [permission] = await this.db
      .update(Permission)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(Permission.id, id))
      .returning();
    return permission;
  }

  /**
   * Delete a permission
   */
  async deletePermission(id: PermissionId) {
    await this.db.delete(Permission).where(eq(Permission.id, id));
  }

  /**
   * Find a permission by ID
   */
  async findPermissionById(id: PermissionId) {
    return this.db.query.Permission.findFirst({
      where: eq(Permission.id, id),
    });
  }

  /**
   * Find a permission by resource and action
   */
  async findPermissionByResourceAction(resource: RestrictedResource, action: UserPermission) {
    return this.db.query.Permission.findFirst({
      where: and(eq(Permission.resource, resource), eq(Permission.action, action)),
    });
  }

  /**
   * Get all permissions
   */
  async getAllPermissions() {
    return this.db.query.Permission.findMany();
  }

  /**
   * Assign a role to a user
   */
  async assignRoleToUser(userId: UserId, roleId: RoleId) {
    const [userRole] = await this.db
      .insert(UserRoleAssignment)
      .values({ userId, roleId })
      .onConflictDoNothing()
      .returning();
    return userRole;
  }

  /**
   * Remove a role from a user
   */
  async removeRoleFromUser(userId: UserId, roleId: RoleId) {
    await this.db
      .delete(UserRoleAssignment)
      .where(and(eq(UserRoleAssignment.userId, userId), eq(UserRoleAssignment.roleId, roleId)));
  }

  /**
   * Get all roles for a user
   */
  async getUserRoles(userId: UserId) {
    const userRoles = await this.db.query.UserRoleAssignment.findMany({
      where: eq(UserRoleAssignment.userId, userId),
      with: {
        role: true,
      },
    });

    return userRoles.map(userRole => userRole.role).filter(Boolean);
  }

  async getUserRoleNames(userId: UserId) {
    const userRoles = await this.getUserRoles(userId);

    const roleNames = new Set<string>();
    for (const role of userRoles) {
      if (role?.name) {
        roleNames.add(role.name);
      }
    }

    return [...roleNames];
  }

  /**
   * Get all users for a role
   */
  async getRoleUsers(roleId: RoleId) {
    const roleUsers = await this.db.query.UserRoleAssignment.findMany({
      where: eq(UserRoleAssignment.roleId, roleId),
      with: {
        user: true,
      },
    });
    return roleUsers.map(userRole => userRole.user);
  }

  /**
   * Assign a permission to a role
   */
  async assignPermissionToRole(roleId: RoleId, permissionId: PermissionId) {
    const [rolePermission] = await this.db
      .insert(RolePermission)
      .values({ roleId, permissionId })
      .onConflictDoNothing()
      .returning();
    return rolePermission;
  }

  /**
   * Remove a permission from a role
   */
  async removePermissionFromRole(roleId: RoleId, permissionId: PermissionId) {
    await this.db
      .delete(RolePermission)
      .where(and(eq(RolePermission.roleId, roleId), eq(RolePermission.permissionId, permissionId)));
  }

  /**
   * Get all permissions for a role
   */
  async getRolePermissions(roleId: RoleId) {
    const rolePermissions = await this.db.query.RolePermission.findMany({
      where: eq(RolePermission.roleId, roleId),
      with: {
        permission: true,
      },
    });
    return rolePermissions.map(rolePermission => rolePermission.permission);
  }

  /**
   * Get all roles for a permission
   */
  async getPermissionRoles(permissionId: PermissionId) {
    const permissionRoles = await this.db.query.RolePermission.findMany({
      where: eq(RolePermission.permissionId, permissionId),
      with: {
        role: true,
      },
    });
    return permissionRoles.map(rolePermission => rolePermission.role);
  }

  /**
   * Get all permissions for a user (derived from their roles)
   */
  async getUserPermissions(userId: UserId) {
    const userRoles = await this.getUserRoles(userId);
    if (userRoles.length === 0) return [];

    const roleIds = userRoles.map(role => role?.id).filter(Boolean);
    const permissions = await this.db.query.RolePermission.findMany({
      where: inArray(RolePermission.roleId, roleIds),
      with: {
        permission: true,
      },
    });

    // Deduplicate permissions
    const uniquePermissions = new Map<string, PermissionModel>();
    for (const rolePermission of permissions) {
      if (rolePermission.permission?.id) {
        uniquePermissions.set(rolePermission.permission.id, rolePermission.permission);
      }
    }

    return [...uniquePermissions.values()];
  }

  /**
   * Check if a user has a specific permission
   */
  async hasPermission(userId: UserId, resource: PermissionModel['resource'], action: PermissionModel['action']) {
    const userPermissions = await this.getUserPermissions(userId);
    return userPermissions.some(permission => permission.resource === resource && permission.action === action);
  }
}

/**
 * Create a user repository
 */
export function createUserRepository(db: Database) {
  return new UserRepository(db);
}
