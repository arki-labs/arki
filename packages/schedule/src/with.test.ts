/**
 * `with: [...]` on a schedule at runtime.
 *
 * Why these tests exist: a refusal must be the run's failure (`refused`, counted in
 * `handlerFailures`) and the handler must not run. What a step returns must reach the handler,
 * and an earlier step's additions must be visible to a later one. An around must wrap everything
 * listed after it (later steps and the handler), pass the handler's result through, and see
 * refusals and handler errors so it can roll back. The runtime tells an around from a step by
 * `fn.length >= 2`; that rule is pinned here, with the shapes an author must not write.
 */
import { describe, expect, it } from 'vitest';

import { defineFailure } from '@arki/failure';

import { initSchedule } from './index.js';
import { createScheduleRuntime } from './runtime.js';

type Principal = { readonly user: { readonly id: string; readonly email: string } };
type BaseContext = { readonly principal: Principal | null };

const SignInRequired = defineFailure('test.with.sign_in', { status: 401 });
const NotAdmin = defineFailure('test.with.not_admin', { status: 403 });

const ada: Principal = { user: { id: 'usr_ada', email: 'ada@arki.dev' } };
const bob: Principal = { user: { id: 'usr_bob', email: 'bob@example.com' } };

const authed = (ctx: { readonly principal: Principal | null }) =>
  ctx.principal === null ? SignInRequired() : { principal: ctx.principal };
const admin = (ctx: { readonly principal: Principal }) =>
  Promise.resolve(ctx.principal.user.email.endsWith('@arki.dev') ? { isAdmin: true as const } : NotAdmin());

const builder = initSchedule.context<BaseContext>().create();

const setupSteps = (principal: Principal | null) => {
  const handled: string[] = [];
  const guarded = builder.define({
    name: 'guarded',
    every: '1h',
    with: [authed, admin],
    handler: ctx => {
      handled.push(ctx.principal.user.id);
      return Promise.resolve({ user: ctx.principal.user.id, isAdmin: ctx.isAdmin });
    },
  });
  const runtime = createScheduleRuntime({ schedules: [guarded], createContext: () => ({ principal }) });
  return { runtime, handled };
};

describe('steps', () => {
  it('a refusal is the run failure and the handler never runs', async () => {
    const { runtime, handled } = setupSteps(null);
    const result = await runtime.trigger('guarded');
    expect(result).toMatchObject({ name: 'guarded', status: 'refused', failure: { code: 'test.with.sign_in' } });
    expect(runtime.handlerFailures).toBe(1);
    expect(handled).toEqual([]);
  });

  it('what the steps return reaches the handler, and a later step reads an earlier one', async () => {
    const { runtime, handled } = setupSteps(ada);
    await expect(runtime.trigger('guarded')).resolves.toEqual({
      name: 'guarded',
      status: 'ran',
      value: { user: 'usr_ada', isAdmin: true },
    });
    expect(handled).toEqual(['usr_ada']);
    expect(runtime.handlerFailures).toBe(0);
  });

  it('a later step refuses with its own failure', async () => {
    const { runtime, handled } = setupSteps(bob);
    await expect(runtime.trigger('guarded')).resolves.toMatchObject({
      status: 'refused',
      failure: { code: 'test.with.not_admin' },
    });
    expect(handled).toEqual([]);
  });

  it('a step that throws is a handler-failed run', async () => {
    const broken = builder.define({
      name: 'broken',
      every: '1h',
      with: [
        () => {
          throw new Error('boom');
        },
      ],
      handler: () => Promise.resolve('never'),
    });
    const runtime = createScheduleRuntime({ schedules: [broken], createContext: () => ({ principal: null }) });
    await expect(runtime.trigger('broken')).resolves.toMatchObject({ status: 'handler-failed' });
  });

  it('without a base context the first step`s additions become the context', async () => {
    const system = initSchedule.create().define({
      name: 'system',
      every: '1h',
      with: [() => ({ system: true as const })],
      handler: ctx => Promise.resolve(ctx),
    });
    await expect(createScheduleRuntime({ schedules: [system] }).trigger('system')).resolves.toEqual({
      name: 'system',
      status: 'ran',
      value: { system: true },
    });
  });
});

const setupArounds = (principal: Principal | null) => {
  const events: string[] = [];
  const recorded = async <T>(_ctx: BaseContext, next: () => Promise<T>) => {
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
  const ok = builder.define({
    name: 'ok',
    every: '1h',
    with: [recorded, loud],
    handler: () => {
      events.push('handler');
      return Promise.resolve('done');
    },
  });
  const boom = builder.define({
    name: 'boom',
    every: '1h',
    with: [recorded, loud],
    handler: () => {
      throw new Error('handler failed');
    },
  });
  const runtime = createScheduleRuntime({ schedules: [ok, boom], createContext: () => ({ principal }) });
  return { runtime, events };
};

describe('around', () => {
  it('wraps later steps and the handler, and passes the result through', async () => {
    const { runtime, events } = setupArounds(ada);
    await expect(runtime.trigger('ok')).resolves.toEqual({ name: 'ok', status: 'ran', value: 'done' });
    expect(events).toEqual(['open', 'step', 'handler', 'commit']);
  });

  it('sees a later refusal as the resolved value and a handler error as a throw', async () => {
    const guest = setupArounds(null);
    await expect(guest.runtime.trigger('ok')).resolves.toMatchObject({ status: 'refused' });
    expect(guest.events).toEqual(['open', 'step', 'commit']);

    const signedIn = setupArounds(ada);
    await expect(signedIn.runtime.trigger('boom')).resolves.toMatchObject({ status: 'handler-failed' });
    expect(signedIn.events).toEqual(['open', 'step', 'rollback']);
  });
});

const inline = async <T>(_ctx: object, next: () => Promise<T>) => next();
const plainStep = (_ctx: object) => ({});
const rest = async (...args: [object, () => Promise<unknown>]) => args[1]();

describe('telling a step from an around', () => {
  it('uses fn.length >= 2: an around declares next as a plain second parameter', () => {
    expect(inline.length).toBe(2);
    expect(plainStep.length).toBe(1);
  });

  it('runs a function with a default `next` as a step: it never gets next', async () => {
    let received: unknown = 'unset';
    // Do not write this: `next = ...` does not count in `fn.length`, so it is run as a step.
    const sloppy = (_ctx: unknown, next: () => Promise<unknown> = () => Promise.resolve('default')) => {
      received = next;
      return {};
    };
    expect(sloppy.length).toBe(1);
    const def = initSchedule.create().define({
      name: 'sloppy',
      every: '1h',
      with: [sloppy],
      handler: () => Promise.resolve('handled'),
    });
    await expect(createScheduleRuntime({ schedules: [def] }).trigger('sloppy')).resolves.toMatchObject({
      status: 'ran',
      value: 'handled',
    });
    expect(typeof received).toBe('function');
  });

  it('runs a rest-parameter function as a step too', () => {
    // Do not write this either: `...rest` has length 0.
    expect(rest.length).toBe(0);
  });
});
