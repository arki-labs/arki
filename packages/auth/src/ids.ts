/**
 * `@arki/auth/ids` — the auth id types and their generators. Browser-safe: no Drizzle, no Zod in
 * the types. Check ids with the schemas on `@arki/auth/zod`; make columns with `@arki/auth/pg`.
 */
import type { IdOf } from '@arki/contracts';

import { accountId, sessionId, userId, verificationId } from './id-declarations.js';

// `UserId` is defined in `@arki/contracts`, so packages that refer to a user share it without
// depending on this package.
export type { UserId } from '@arki/contracts';
export type SessionId = IdOf<typeof sessionId>;
export type AccountId = IdOf<typeof accountId>;
export type VerificationId = IdOf<typeof verificationId>;

/** A new user id: `usr_` and 24 random letters and digits. */
export const createUserId = userId.create;
export const createSessionId = sessionId.create;
export const createAccountId = accountId.create;
export const createVerificationId = verificationId.create;
