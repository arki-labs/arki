/**
 * `@arki/auth/ids` — the auth id types and their generators. Browser-safe: no Drizzle, no Zod in
 * the types. Check ids with the schemas on `@arki/auth/zod`; make columns with `@arki/auth/pg`.
 */
import type { UserId } from '@arki/contracts';

import { accountId, sessionId, userId, verificationId } from './id-declarations.js';

// `UserId` is defined in `@arki/contracts`, so packages that refer to a user share it without
// depending on this package.
export type { UserId } from '@arki/contracts';
export type SessionId = `sess_${string}`;
export type AccountId = `acc_${string}`;
export type VerificationId = `verif_${string}`;

/** A new user id: `usr_` and 24 random letters and digits. */
export const createUserId: () => UserId = userId.create;
export const createSessionId: () => SessionId = sessionId.create;
export const createAccountId: () => AccountId = accountId.create;
export const createVerificationId: () => VerificationId = verificationId.create;
