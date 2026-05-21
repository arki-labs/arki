/**
 * Seed script to ensure system user exists in the database
 * Run this during application initialization or as a migration
 */

import type { Database } from '../../../db';

import { eq } from 'drizzle-orm';
import { User } from '../../auth/schema';
import type { UserId } from '../types';
import { SYSTEM_USER, SYSTEM_USER_ID } from '../constants';

export async function ensureSystemUserExists(db: Database): Promise<void> {
  // Check if system user already exists
  const existingUser = await db.query.User.findFirst({
    where: { RAW: eq(User.id, SYSTEM_USER_ID) },
  });

  if (!existingUser) {
    // Create system user if it doesn't exist
    await db.insert(User).values({
      id: SYSTEM_USER_ID,
      email: SYSTEM_USER.email,
      name: SYSTEM_USER.name,
      // Add other required fields based on your user schema
      emailVerified: true, // System user is pre-verified
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    console.log('System user created successfully');
  } else {
    console.log('System user already exists');
  }
}

/**
 * Helper to check if an action was performed by the system
 */
export function isSystemAction(userId: UserId | null | undefined): boolean {
  return userId === SYSTEM_USER_ID;
}
