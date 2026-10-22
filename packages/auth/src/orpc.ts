/**
 * `@arki/auth/orpc` — ownership checks and policy checks for oRPC procedures. Principal checks are
 * the plain steps in `@arki/auth` (`step(authed)` with `step` from `@arki/dot/orpc`).
 *
 * Three assertion functions, no policy engine. Each replaces the
 * load-then-check pair (`if (!row) …; if (row.userId !== …) …`) with one
 * call, and narrows the row to non-null for the rest of the handler — no
 * later `!` or `as`.
 *
 * `auth.not_found` or `auth.forbidden` is a choice the procedure makes, by name:
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
import type { Context, Meta, MiddlewareOptions, MiddlewareResult, ORPCErrorConstructorMap } from '@orpc/server';

import type { DeclaredErrors, ErrorMapOf } from '@arki/failure/orpc';
import { orThrowRpc } from '@arki/failure/orpc';

import type { AUTH_POLICY_FAILURES } from './boundary-failures.js';
import type { AnyPolicies, GroupOf, Loaded, PolicyName, PrincipalOfPolicies, SubjectOf } from './policies.js';
import type { AnyPrincipal } from './principal.js';
import { AccessDenied, AuthenticationRequired, ResourceMissing } from './boundary-failures.js';
import { AUTH_ERROR_CODES, AuthError } from './errors.js';
import { authorizePolicy, groupOf, keyed } from './policies.js';

/** Anything with an owner: the row's `userId`. */
export type Owned = { readonly userId: string };

/** Missing → `auth.not_found`. For rows the query already scoped to the caller (`getOwned`). */
export function assertFound<T>(
  row: T | null | undefined,
  errors: DeclaredErrors<ReturnType<typeof ResourceMissing>>,
): asserts row is T {
  if (row === null || row === undefined) {
    orThrowRpc(ResourceMissing(), errors);
  }
}

/** Reads: missing OR someone else's → `auth.not_found`. A stranger cannot tell the two apart. */
export function assertOwnedOrNotFound<T extends Owned>(
  row: T | null | undefined,
  actorId: string,
  errors: DeclaredErrors<ReturnType<typeof ResourceMissing>>,
): asserts row is T {
  if (row === null || row === undefined || row.userId !== actorId) {
    orThrowRpc(ResourceMissing(), errors);
  }
}

/** Mutations: missing → `auth.not_found`; someone else's → `auth.forbidden` (the caller already had the id). */
export function assertOwnedOrForbidden<T extends Owned>(
  row: T | null | undefined,
  actorId: string,
  errors: DeclaredErrors<ReturnType<typeof ResourceMissing>> & DeclaredErrors<ReturnType<typeof AccessDenied>>,
): asserts row is T {
  assertFound(row, errors);
  if (row.userId !== actorId) {
    orThrowRpc(AccessDenied(), errors);
  }
}

/** The contract meta must name the policy `can` checks, so `dot explain` never shows a wrong one. */
function assertDeclared(meta: Meta, name: string): void {
  const declared: unknown = meta['policy'];
  if (declared === name) return;
  throw new AuthError(
    AUTH_ERROR_CODES.policyNotDeclared,
    `The procedure checks policy "${name}", but its contract meta declares ${typeof declared === 'string' ? `"${declared}"` : 'none'}. Add .meta({ policy: '${name}' }) to the contract.`,
  );
}

/**
 * The middleware `can` returns. `X` is the context the procedure has where it is used, `I` its
 * input. The handler after it sees `context.principal` (non-null) and the loaded subject under its
 * group's name (`context.order`).
 */
export type PolicyGuard<X, I, P, K extends string, S> = <TOutput>(
  options: MiddlewareOptions<
    X & Context,
    TOutput,
    ORPCErrorConstructorMap<ErrorMapOf<typeof AUTH_POLICY_FAILURES>>,
    Meta
  >,
  input: I,
) => Promise<MiddlewareResult<{ readonly principal: P } & Readonly<Record<K, S>>, TOutput>>;

/** Loads a policy's subject by the procedure's input, with the full context and a signed-in principal. */
export type PolicyLoader<I, X, P, S> = (input: I, context: X & { readonly principal: P }) => Loaded<S>;

/**
 * Signs in, loads the subject, runs the named policy. The procedure's contract meta must name
 * the same policy (`.meta({ policy: 'order.refund' })`), so `dot explain` shows it; a missing or
 * different name is `ARKI_AUTH_E008`.
 *
 * - a guest → `auth.unauthenticated` (401); the loader does not run;
 * - no such subject, or the group's `view` refuses → `auth.not_found` (404; hidden and missing look identical);
 * - the policy refuses → `auth.forbidden` (403).
 *
 * The loader's context is the procedure's, at the `.use()` that attaches it.
 *
 * @example
 * impl.refund
 *   .use(can(orderPolicies)('order.refund', ({ id }, { usecases }) => usecases.findOrder(id)))
 *   .handler(({ context }) => context.usecases.refund(context.order));
 */
export function can<T extends AnyPolicies>(policies: T) {
  return <N extends PolicyName<T>, I, X extends { readonly principal: (AnyPrincipal & PrincipalOfPolicies<T>) | null }>(
      name: N,
      load: PolicyLoader<I, X, NonNullable<X['principal']>, SubjectOf<T, N>>,
    ): PolicyGuard<X, I, NonNullable<X['principal']>, GroupOf<N>, SubjectOf<T, N>> =>
    async (options, input) => {
      assertDeclared(options.procedure['~orpc'].meta, name);
      const principal: NonNullable<X['principal']> | null = options.context.principal;
      if (principal === null) return orThrowRpc(AuthenticationRequired(), options.errors);
      const subject = await authorizePolicy(
        policies,
        name,
        principal,
        await load(input, { ...options.context, principal }),
      );
      if (AccessDenied.is(subject)) return orThrowRpc(AccessDenied(), options.errors);
      if (ResourceMissing.is(subject)) return orThrowRpc(ResourceMissing(), options.errors);
      return options.next({ context: { principal, ...keyed(groupOf(name), subject) } });
    };
}
