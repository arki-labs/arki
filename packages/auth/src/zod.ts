/**
 * `@arki/auth/zod` — Zod schemas for the auth ids and an email address, for apps that validate
 * input with Zod. Every other entry is schema-library free.
 */
import { z } from '@arki/contracts';

export {
  accountIdSchema,
  permissionIdSchema,
  roleIdSchema,
  sessionIdSchema,
  userIdSchema,
  userVerificationIdSchema as verificationIdSchema,
} from './ids.js';
export { organizationIdSchema, teamIdSchema } from './pg/workspaces/schema.js';

/** An email address. */
export const emailSchema = z.email();
