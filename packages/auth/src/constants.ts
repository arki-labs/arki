/**
 * Cross-package shared auth constants.
 *
 * Importing apps consume these to keep client-side and server-side
 * configurations in lockstep (per D-impl-13 + C2 fix in
 * `apps/novelette/docs/features/authentication/.work/reviews/20260529-l3-review-findings.md`).
 */

export const PASSWORD_MIN_LENGTH = 8;

/** Shortest auth secret accepted in production. Matches Better Auth's own warning threshold. */
export const AUTH_SECRET_MIN_LENGTH = 32;
