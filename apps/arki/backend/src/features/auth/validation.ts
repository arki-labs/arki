import { z } from '@arki/contracts';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';

import { User } from './schema';

// User validation schemas
export const userSelectSchema = createSelectSchema(User);

// Base user schema for common validations
const userBaseSchema = z.object({
  name: z.string().nullable().optional(),
  email: z.email(),
  image: z.url().nullable().optional(),
});

// Insert schema - requires all mandatory fields
export const userInsertSchema = createInsertSchema(User, {
  ...userBaseSchema.shape,
});

// Update schema - all fields are optional
export const userUpdateSchema = userBaseSchema.partial();
