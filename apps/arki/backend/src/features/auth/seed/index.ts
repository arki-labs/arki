import { createHash } from 'node:crypto';

import { seedAdminUser, seedPermissionsAndRoles } from './permissions-roles';

// Helper function to hash passwords securely using Node's crypto module
const hashPassword = (password: string): string => {
  return createHash('sha256').update(password).digest('hex');
};

/**
 * Main seed function that runs all seed scripts
 */
async function seed() {
  try {
    console.log('Starting database seeding...');

    // Seed permissions and roles first
    await seedPermissionsAndRoles();

    // Seed admin user
    await seedAdminUser(
      'admin@example.com',
      'Admin User',
      hashPassword('adminpassword123'), // Default password for development
    );

    console.log('Database seeding completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Error seeding database:', error);
    process.exit(1);
  }
}

// Run the seed function
seed();
