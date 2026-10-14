import type { RestrictedResource, UserPermission } from '../schema';
import { repositories } from '../../../db';
import { ADMIN_ROLE_NAME } from '../constants';

/**
 * Define standard permissions for the application
 */
const STANDARD_PERMISSIONS: {
  resource: RestrictedResource;
  action: UserPermission;
  name: string;
  description: string;
}[] = [
  // User permissions
  { resource: 'user', action: 'create', name: 'Create User', description: 'Create a new user' },
  { resource: 'user', action: 'read', name: 'Read User', description: 'Read user information' },
  { resource: 'user', action: 'update', name: 'Update User', description: 'Update user information' },
  { resource: 'user', action: 'delete', name: 'Delete User', description: 'Delete a user' },

  // Content permissions
  { resource: 'poem', action: 'create', name: 'Create Poem', description: 'Create a new poem' },
  { resource: 'poem', action: 'read', name: 'Read Poem', description: 'Read poem content' },
  { resource: 'poem', action: 'update', name: 'Update Poem', description: 'Update poem content' },
  { resource: 'poem', action: 'delete', name: 'Delete Poem', description: 'Delete a poem' },

  // Comment permissions
  { resource: 'comment', action: 'create', name: 'Create Comment', description: 'Create a new comment' },
  { resource: 'comment', action: 'read', name: 'Read Comment', description: 'Read comment content' },
  { resource: 'comment', action: 'update', name: 'Update Comment', description: 'Update comment content' },
  { resource: 'comment', action: 'delete', name: 'Delete Comment', description: 'Delete a comment' },

  // Workshop permissions
  { resource: 'workshop', action: 'create', name: 'Create Workshop', description: 'Create a new workshop' },
  { resource: 'workshop', action: 'read', name: 'Read Workshop', description: 'View workshop content' },
  { resource: 'workshop', action: 'update', name: 'Update Workshop', description: 'Update workshop settings' },
  { resource: 'workshop', action: 'delete', name: 'Delete Workshop', description: 'Delete a workshop' },
  { resource: 'workshop', action: 'join', name: 'Join Workshop', description: 'Join an existing workshop' },

  // System permissions
  { resource: 'system', action: 'admin', name: 'System Admin', description: 'Full system administration' },
  { resource: 'system', action: 'moderate', name: 'Moderate Content', description: 'Moderate user content' },
];

/**
 * Define standard roles with associated permissions
 */
const STANDARD_ROLES: {
  name: string;
  description: string;
  isDefault?: boolean;
  permissions: { resource: RestrictedResource; action: UserPermission }[];
}[] = [
  {
    name: 'User',
    description: 'Regular user with standard permissions',
    isDefault: true,
    permissions: [
      { resource: 'user', action: 'read' },
      { resource: 'user', action: 'update' },
      { resource: 'poem', action: 'create' },
      { resource: 'poem', action: 'read' },
      { resource: 'poem', action: 'update' },
      { resource: 'poem', action: 'delete' },
      { resource: 'comment', action: 'create' },
      { resource: 'comment', action: 'read' },
      { resource: 'comment', action: 'update' },
      { resource: 'comment', action: 'delete' },
      { resource: 'workshop', action: 'create' },
      { resource: 'workshop', action: 'read' },
      { resource: 'workshop', action: 'join' },
    ],
  },
  {
    name: 'Moderator',
    description: 'Content moderator with elevated permissions',
    permissions: [
      { resource: 'user', action: 'read' },
      { resource: 'poem', action: 'read' },
      { resource: 'poem', action: 'update' },
      { resource: 'poem', action: 'delete' },
      { resource: 'comment', action: 'read' },
      { resource: 'comment', action: 'update' },
      { resource: 'comment', action: 'delete' },
      { resource: 'workshop', action: 'read' },
      { resource: 'system', action: 'moderate' },
    ],
  },
  {
    name: ADMIN_ROLE_NAME,
    description: 'Administrator with full system access',
    permissions: [
      { resource: 'system', action: 'admin' },
      // Admin has all permissions
    ],
  },
];

/**
 * Seed permissions and roles
 */
export async function seedPermissionsAndRoles() {
  console.log('Seeding permissions...');

  // Create permissions
  const permissionMap = new Map();

  for (const permDef of STANDARD_PERMISSIONS) {
    // Check if permission already exists
    let permission = await repositories.auth.findPermissionByResourceAction(permDef.resource, permDef.action);

    if (permission) {
      console.log(`Permission exists: ${permDef.name}`);
    } else {
      permission = await repositories.auth.createPermission({
        name: permDef.name,
        description: permDef.description,
        resource: permDef.resource,
        action: permDef.action,
      });
      console.log(`Created permission: ${permDef.name}`);
    }

    // Store in map for role assignment
    permissionMap.set(`${permDef.resource}:${permDef.action}`, permission);
  }

  console.log('Seeding roles...');

  // Create roles
  for (const roleDef of STANDARD_ROLES) {
    // Check if role already exists
    let role = await repositories.auth.findRoleByName(roleDef.name);

    if (role) {
      console.log(`Role exists: ${roleDef.name}`);
    } else {
      role = await repositories.auth.createRole({
        name: roleDef.name,
        description: roleDef.description,
        isDefault: roleDef.isDefault || false,
        isSystem: roleDef.name === ADMIN_ROLE_NAME, // Mark Admin as system role
      });
      console.log(`Created role: ${roleDef.name}`);
    }

    // Only proceed if role was created or found
    if (!role) {
      console.log(`Failed to create or find role: ${roleDef.name}`);
      continue;
    }

    // Assign permissions to role
    if (roleDef.name === ADMIN_ROLE_NAME) {
      // Admin gets all permissions
      for (const [, permission] of Array.from(permissionMap.entries())) {
        await repositories.auth.assignPermissionToRole(role.id, permission.id);
      }
    } else {
      // Other roles get specific permissions
      for (const permDef of roleDef.permissions) {
        const permission = permissionMap.get(`${permDef.resource}:${permDef.action}`);
        if (permission) {
          await repositories.auth.assignPermissionToRole(role.id, permission.id);
        }
      }
    }
  }

  console.log('Permission and role seeding complete.');
}

/**
 * Seed admin user
 */
export async function seedAdminUser(email: string, name: string, hashedPassword: string) {
  console.log(`Checking for admin user: ${email}`);

  let user = await repositories.auth.findByEmail(email);

  if (user) {
    console.log(`Admin user exists: ${email}`);
  } else {
    console.log(`Creating admin user: ${email}`);
    user = await repositories.auth.create({
      email,
      name,
      emailVerified: true,
      image: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    console.log(
      `Admin user created: ${email} (password must be set via Better Auth flow: ${hashedPassword.slice(0, 8)}…)`,
    );
  }

  if (!user) {
    console.error(`Failed to create or find admin user: ${email}`);
    return null;
  }

  // Assign Admin role
  const adminRole = await repositories.auth.findRoleByName(ADMIN_ROLE_NAME);
  if (adminRole) {
    await repositories.auth.assignRoleToUser(user.id, adminRole.id);
    console.log(`Assigned Admin role to user: ${email}`);
  } else {
    console.error('Admin role not found. Run seedPermissionsAndRoles first.');
  }

  return user;
}
