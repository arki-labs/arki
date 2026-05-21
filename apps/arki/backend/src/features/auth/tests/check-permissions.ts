import { repositories } from '../../../db';

const userRepository = repositories.auth;

/**
 * A simple test script to verify permissions
 *
 * Usage:
 * pnpm tsx src/features/auth/tests/check-permissions.ts
 */
async function runPermissionsTest() {
  try {
    console.log('Testing permissions system...');

    // Test: Retrieve admin user
    const adminUser = await userRepository.findByEmail('admin@example.com');
    if (!adminUser) {
      console.error('Admin user not found. Please run the seed script first.');
      process.exit(1);
    }

    console.log(`Found admin user: ${adminUser.name} (${adminUser.email})`);

    // Test: Get roles for admin user
    const adminRoles = await userRepository.getUserRoles(adminUser.id);
    console.log('Admin roles:', adminRoles.filter((r): r is NonNullable<typeof r> => r !== null).map(r => r.name).join(', '));

    // Test: Get permissions for admin user
    const adminPermissions = await userRepository.getUserPermissions(adminUser.id);
    console.log('Admin permissions count:', adminPermissions.length);
    console.log(
      'Sample permissions:',
      adminPermissions.slice(0, 5).map(p => `${p.resource}:${p.action}`),
    );

    // Test: Check specific permissions
    const hasAdminPerm = await userRepository.hasPermission(adminUser.id, 'system', 'admin');
    console.log('Has system admin permission:', hasAdminPerm);

    const hasPoem = await userRepository.hasPermission(adminUser.id, 'poem', 'create');
    console.log('Has poem create permission:', hasPoem);

    // Create a regular user for comparison
    let regularUser = await userRepository.findByEmail('user@example.com');
    if (regularUser) {
      console.log('Using existing regular user for testing');
    } else {
      regularUser = await userRepository.create({
        name: 'Regular User',
        email: 'user@example.com',
        emailVerified: false,
      });
      console.log('Created regular user for testing');
    }

    // Make sure we have a valid user
    if (!regularUser) {
      console.error('Failed to create or find regular user');
      process.exit(1);
    }

    // Test: Assign User role
    const userRole = await userRepository.findRoleByName('User');
    if (userRole) {
      await userRepository.assignRoleToUser(regularUser.id, userRole.id);
    }

    // Test: Get permissions for regular user
    const userPermissions = await userRepository.getUserPermissions(regularUser.id);
    console.log('Regular user permissions count:', userPermissions.length);
    console.log(
      'Sample permissions:',
      userPermissions.slice(0, 5).map(p => `${p.resource}:${p.action}`),
    );

    // Test: Check specific permissions for regular user
    const userHasSystemAdmin = await userRepository.hasPermission(regularUser.id, 'system', 'admin');
    console.log('Regular user has system admin permission:', userHasSystemAdmin);

    const userHasPoem = await userRepository.hasPermission(regularUser.id, 'poem', 'create');
    console.log('Regular user has poem create permission:', userHasPoem);

    // Create a moderator for testing
    let moderator = await userRepository.findByEmail('moderator@example.com');
    if (moderator) {
      console.log('Using existing moderator user for testing');
    } else {
      moderator = await userRepository.create({
        name: 'Content Moderator',
        email: 'moderator@example.com',
        emailVerified: false,
      });
      console.log('Created moderator user for testing');
    }

    // Make sure we have a valid moderator
    if (!moderator) {
      console.error('Failed to create or find moderator user');
      process.exit(1);
    }

    // Test: Assign Moderator role
    const moderatorRole = await userRepository.findRoleByName('Moderator');
    if (moderatorRole) {
      await userRepository.assignRoleToUser(moderator.id, moderatorRole.id);
    }

    // Test: Get permissions for moderator
    const moderatorPermissions = await userRepository.getUserPermissions(moderator.id);
    console.log('Moderator permissions count:', moderatorPermissions.length);
    console.log(
      'Sample permissions:',
      moderatorPermissions.slice(0, 5).map(p => `${p.resource}:${p.action}`),
    );

    // Test: Check specific permissions for moderator
    const modHasSystemModerate = await userRepository.hasPermission(moderator.id, 'system', 'moderate');
    console.log('Moderator has content moderation permission:', modHasSystemModerate);

    console.log('Permission tests completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Error testing permissions:', error);
    process.exit(1);
  }
}

// Run the test
runPermissionsTest();
