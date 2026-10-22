/**
 * `step` and `around` (`@arki/dot/orpc`) at runtime.
 *
 * Why these tests exist: a refusal must reach the client as the typed error the procedure declares
 * (same code, status and `defined: true`), never as a generic 500, and the handler must not run.
 * What a step returns must be on the handler's context, and an earlier step's additions must be
 * visible to a later one. An around must wrap everything declared after it — later steps and the
 * handler — and pass the handler's result through untouched, so a transaction or retry can own it.
 */
import { createRouterClient, ORPCError, os } from '@orpc/server';
import { describe, expect, it, vi } from 'vitest';

import { defineFailure } from '@arki/failure';
import { errorMap } from '@arki/failure/orpc';

import { around, step } from '../orpc.js';

type Principal = { readonly user: { readonly id: string; readonly email: string } };
type RequestContext = { readonly principal: Principal | null; readonly headers: Headers };

const SignInRequired = defineFailure('test.step.sign_in', { status: 401 });
const NotAdmin = defineFailure('test.step.not_admin', { status: 403 });

const authed = (ctx: { readonly principal: Principal | null }) =>
  ctx.principal === null ? SignInRequired() : { principal: ctx.principal };
const admin = (ctx: { readonly principal: Principal }) =>
  Promise.resolve(ctx.principal.user.email.endsWith('@arki.dev') ? { isAdmin: true as const } : NotAdmin());

const clientFor = (principal: Principal | null, handler = vi.fn((id: string) => id)) => {
  const router = {
    profile: os
      .$context<RequestContext>()
      .errors(errorMap(SignInRequired))
      .use(step(authed))
      .handler(({ context }) => handler(context.principal.user.id)),
    adminStats: os
      .$context<RequestContext>()
      .errors(errorMap(SignInRequired, NotAdmin))
      .use(step(authed))
      .use(step(admin))
      .handler(({ context }) => ({ user: context.principal.user.id, isAdmin: context.isAdmin })),
  };
  return { client: createRouterClient(router, { context: { principal, headers: new Headers() } }), handler };
};

const ada: Principal = { user: { id: 'usr_ada', email: 'ada@arki.dev' } };
const bob: Principal = { user: { id: 'usr_bob', email: 'bob@example.com' } };

describe('step', () => {
  it('a guest gets the declared 401 and the handler never runs', async () => {
    const { client, handler } = clientFor(null);
    const error: unknown = await client.profile().catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({ code: 'test.step.sign_in', status: 401, defined: true });
    expect(handler).not.toHaveBeenCalled();
  });

  it('a signed-in caller reaches the handler with what the step returned', async () => {
    await expect(clientFor(ada).client.profile()).resolves.toBe('usr_ada');
  });

  it('a later step reads what the earlier step added', async () => {
    await expect(clientFor(ada).client.adminStats()).resolves.toEqual({ user: 'usr_ada', isAdmin: true });
  });

  it('a later step refuses with its own declared error', async () => {
    const error: unknown = await clientFor(bob)
      .client.adminStats()
      .catch((error_: unknown) => error_);
    expect(error).toMatchObject({ code: 'test.step.not_admin', status: 403, defined: true });
  });
});

const tracedClient = (events: string[]) => {
  const recorded = async <T>(_ctx: RequestContext, next: () => Promise<T>) => {
    events.push('open');
    try {
      const result = await next();
      events.push('commit');
      return result;
    } catch (error) {
      events.push('rollback');
      throw error;
    }
  };
  const loud = (ctx: { readonly principal: Principal | null }) => {
    events.push('step');
    return authed(ctx);
  };
  const base = os.$context<RequestContext>().errors(errorMap(SignInRequired)).use(around(recorded)).use(step(loud));
  const router = {
    ok: base.handler(() => {
      events.push('handler');
      return 'done';
    }),
    boom: base.handler(() => {
      throw new Error('handler failed');
    }),
  };
  return (principal: Principal | null) =>
    createRouterClient(router, { context: { principal, headers: new Headers() } });
};

describe('around', () => {
  it('wraps later steps and the handler, and passes the result through', async () => {
    const events: string[] = [];
    await expect(tracedClient(events)(ada).ok()).resolves.toBe('done');
    expect(events).toEqual(['open', 'step', 'handler', 'commit']);
  });

  it('sees a refusal from a later step and a handler error, so it can roll back', async () => {
    const events: string[] = [];
    const client = tracedClient(events);
    await expect(client(null).ok()).rejects.toMatchObject({ code: 'test.step.sign_in' });
    await expect(client(ada).boom()).rejects.toThrow();
    expect(events).toEqual(['open', 'step', 'rollback', 'open', 'step', 'rollback']);
  });
});
