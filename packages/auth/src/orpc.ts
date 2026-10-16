/**
 * `@arki/auth/orpc` — ownership checks for oRPC procedures.
 *
 * Three assertion functions, no policy engine. Each replaces the
 * load-then-check pair (`if (!row) …; if (row.userId !== …) …`) with one
 * call, and narrows the row to non-null for the rest of the handler — no
 * later `!` or `as`.
 *
 * NOT_FOUND or FORBIDDEN is a choice the procedure makes, by name:
 *
 * - {@link assertOwnedOrNotFound} — reads. Someone else's row looks exactly
 *   like a missing one, so ids cannot be probed for existence.
 * - {@link assertOwnedOrForbidden} — mutations where the caller already holds
 *   the id. "Not yours" is a useful hint there (wrong account), and the
 *   existence it reveals was known to the caller anyway.
 * - {@link assertFound} — for rows already filtered by owner in the query
 *   (the `getOwned(id, userId)` repository convention, see the README):
 *   the query cannot return someone else's row, so only "missing" is left.
 *
 * Ids are compared as plain strings, so a branded `UserId` row and a
 * `context.session.user.id` string fit without a cast.
 *
 * `@orpc/server` is an optional peer: import this module only in an app
 * that serves oRPC.
 */
import type { Meta, MiddlewareOptions, MiddlewareResult } from '@orpc/server';
import { ORPCError } from '@orpc/server';

import type { AnyPrincipal } from './principal.js';
import { AUTH_ERROR_CODES } from './errors.js';

/** Anything with an owner: the row's `userId`. */
export type Owned = { readonly userId: string };

/** Missing → NOT_FOUND. For rows the query already scoped to the caller (`getOwned`). */
export function assertFound<T>(row: T | null | undefined, label: string): asserts row is T {
  if (row === null || row === undefined) {
    throw new ORPCError('NOT_FOUND', { message: `${label} not found` });
  }
}

/** Reads: missing OR someone else's → NOT_FOUND. A stranger cannot tell the two apart. */
export function assertOwnedOrNotFound<T extends Owned>(
  row: T | null | undefined,
  actorId: string,
  label: string,
): asserts row is T {
  if (row === null || row === undefined || row.userId !== actorId) {
    throw new ORPCError('NOT_FOUND', { message: `${label} not found` });
  }
}

/** Mutations: missing → NOT_FOUND; someone else's → FORBIDDEN (the caller already had the id). */
export function assertOwnedOrForbidden<T extends Owned>(
  row: T | null | undefined,
  actorId: string,
  label: string,
): asserts row is T {
  assertFound(row, label);
  if (row.userId !== actorId) {
    throw new ORPCError('FORBIDDEN', { message: `You do not have access to this ${label}` });
  }
}

/**
 * Principal guards for oRPC procedures. `C` is the app's request context; its `principal` is the
 * auth's principal or `null` for a guest. Each guard narrows `context.principal` to non-null.
 *
 * - `authed`: a guest → `UNAUTHORIZED` with `data.code` `ARKI_AUTH_E401`.
 * - `verified`: also refuses an unverified email → `FORBIDDEN`, `ARKI_AUTH_E403`.
 * - `role(name)`: also refuses a principal without that role → `FORBIDDEN`, `ARKI_AUTH_E403`.
 *
 * @example
 * export const { authed, verified, role } = guards<RequestContext>();
 * impl.adminStats.use(role('admin')).handler(({ context }) => stats(context.principal.user.id));
 */
const forbidden = (message: string) =>
  new ORPCError('FORBIDDEN', { message, data: { code: AUTH_ERROR_CODES.forbidden } });

export type PrincipalGuard<C extends { readonly principal: AnyPrincipal | null }> = <TOutput>(
  options: MiddlewareOptions<C, TOutput, Record<never, never>, Meta>,
) => MiddlewareResult<{ readonly principal: NonNullable<C['principal']> }, TOutput>;

export function guards<C extends { readonly principal: AnyPrincipal | null }>(): {
  readonly authed: PrincipalGuard<C>;
  readonly verified: PrincipalGuard<C>;
  readonly role: (name: string) => PrincipalGuard<C>;
} {
  const signedIn = (principal: C['principal']): NonNullable<C['principal']> => {
    if (principal === null) {
      throw new ORPCError('UNAUTHORIZED', {
        message: 'Sign in to continue.',
        data: { code: AUTH_ERROR_CODES.unauthenticated },
      });
    }
    return principal;
  };
  return {
    authed: ({ context, next }) => next({ context: { principal: signedIn(context.principal) } }),
    verified: ({ context, next }) => {
      const principal = signedIn(context.principal);
      if (!principal.user.emailVerified) throw forbidden('Verify your email address first.');
      return next({ context: { principal } });
    },
    role:
      name =>
      ({ context, next }) => {
        const principal = signedIn(context.principal);
        if (!principal.roles.includes(name)) throw forbidden('You do not have access to this.');
        return next({ context: { principal } });
      },
  };
}
