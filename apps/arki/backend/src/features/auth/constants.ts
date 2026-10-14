import type { UserId } from './types';

/**
 * System user ID for automated actions
 * This user should be created in the database during initialization
 */
export const SYSTEM_USER_ID = 'usystem' as UserId;

/**
 * The seeded administrator role. The seed creates it and the admin middleware looks for it by this exact name.
 */
export const ADMIN_ROLE_NAME = 'Admin';

/**
 * System user details for database seeding
 */
export const SYSTEM_USER = {
  id: SYSTEM_USER_ID,
  email: 'system@internal.strophie',
  name: 'System (Automated)',
  role: 'system',
} as const;
