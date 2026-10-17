/**
 * `@arki/auth/zod` — Zod schemas for the auth ids and an email address, for apps that validate
 * input with Zod. Every other entry is schema-library free.
 *
 * Each id schema takes a plain `string` and gives the id type (`` `usr_${string}` ``), as these
 * schemas always have: an input field typed by one of them stays `string` for the caller. The
 * prefix and the check come from the same `defineId` declarations `./ids` and `./pg` use.
 */
import type { IdDeclaration } from '@arki/contracts';
import { z } from '@arki/contracts';

import {
  accountId,
  organizationId,
  permissionId,
  roleId,
  sessionId,
  teamId,
  userId,
  verificationId,
} from './id-declarations.js';

/** A schema that takes a string and gives the declaration's id type, or fails with the prefix it wanted. */
function idSchema<const P extends string>(declaration: IdDeclaration<P>) {
  return z.string().transform((value, context): `${P}${string}` => {
    if (declaration.is(value)) return value;
    context.addIssue({ code: 'custom', message: `Expected an id starting with "${declaration.prefix}"` });
    return z.NEVER;
  });
}

export const userIdSchema = idSchema(userId);
export const sessionIdSchema = idSchema(sessionId);
export const accountIdSchema = idSchema(accountId);
export const verificationIdSchema = idSchema(verificationId);
export const roleIdSchema = idSchema(roleId);
export const permissionIdSchema = idSchema(permissionId);
export const organizationIdSchema = idSchema(organizationId);
export const teamIdSchema = idSchema(teamId);

/** An email address. */
export const emailSchema = z.email();
