/**
 * `derive` + `fromDerive` (`@arki/dot/orpc`) at runtime.
 *
 * Why these tests exist: a refusal must reach the client as the typed error the procedure declares
 * (same code, status and `defined: true`), never as a generic 500, and the handler must not run.
 * What a step adds must be on the handler's context under the key the step named (keyed form) or
 * the keys it returned (object form), and an earlier step's additions must be visible to a later one.
 */
import { createRouterClient, ORPCError, os } from '@orpc/server';
import { describe, expect, it, vi } from 'vitest';

import { defineFailure } from '@arki/failure';
import { errorMap } from '@arki/failure/orpc';

import { derive } from '../middleware.js';
import { fromDerive } from '../orpc.js';

type Principal = { readonly user: { readonly id: string; readonly email: string } };
type RequestContext = { readonly principal: Principal | null; readonly headers: Headers };

const SignInRequired = defineFailure('test.derive.sign_in', { status: 401 });
const NotAdmin = defineFailure('test.derive.not_admin', { status: 403 });

const authed = derive('principal', (ctx: { readonly principal: Principal | null }) =>
  ctx.principal === null ? SignInRequired() : ctx.principal,
);
const admin = derive((ctx: { readonly principal: Principal }) =>
  Promise.resolve(ctx.principal.user.email.endsWith('@arki.dev') ? { isAdmin: true as const } : NotAdmin()),
);

const clientFor = (principal: Principal | null, handler = vi.fn((id: string) => id)) => {
  const router = {
    profile: os
      .$context<RequestContext>()
      .errors(errorMap(SignInRequired))
      .use(fromDerive(authed))
      .handler(({ context }) => handler(context.principal.user.id)),
    adminStats: os
      .$context<RequestContext>()
      .errors(errorMap(SignInRequired, NotAdmin))
      .use(fromDerive(authed))
      .use(fromDerive(admin))
      .handler(({ context }) => ({ user: context.principal.user.id, isAdmin: context.isAdmin })),
  };
  return { client: createRouterClient(router, { context: { principal, headers: new Headers() } }), handler };
};

const ada: Principal = { user: { id: 'usr_ada', email: 'ada@arki.dev' } };
const bob: Principal = { user: { id: 'usr_bob', email: 'bob@example.com' } };

describe('fromDerive', () => {
  it('a guest gets the declared 401 and the handler never runs', async () => {
    const { client, handler } = clientFor(null);
    const error: unknown = await client.profile().catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({ code: 'test.derive.sign_in', status: 401, defined: true });
    expect(handler).not.toHaveBeenCalled();
  });

  it('a signed-in caller reaches the handler with the principal under the step key', async () => {
    const { client } = clientFor(ada);
    await expect(client.profile()).resolves.toBe('usr_ada');
  });

  it('an object step adds its keys and reads what the earlier step added', async () => {
    await expect(clientFor(ada).client.adminStats()).resolves.toEqual({ user: 'usr_ada', isAdmin: true });
  });

  it('a later step refuses with its own declared error', async () => {
    const error: unknown = await clientFor(bob)
      .client.adminStats()
      .catch((error_: unknown) => error_);
    expect(error).toMatchObject({ code: 'test.derive.not_admin', status: 403, defined: true });
  });
});
