/**
 * `step` and `around` (`@arki/http`) at runtime.
 *
 * Why these tests exist: a step replaced the keyed `derive`, so its refusal must answer with the
 * exact coded envelope a `derive` refusal answered with (status and bytes, pinned as a literal), and
 * the handler must not run. What a step
 * returns must reach the handler and later steps. An around must wrap every step declared after it
 * and the handler, pass the response through unchanged, and see a refusal and a handler error, so a
 * transaction can commit or roll back.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineFailure } from '@arki/failure';

import { routes } from '../bundle.js';
import { buildEngine } from '../compiled.js';
import { route } from '../contract.js';
import { around, step } from '../middleware.js';

const SignInRequired = defineFailure('test.step.sign_in', { status: 401 });
const NotAdmin = defineFailure('test.step.not_admin', { status: 403 });

const authed = (ctx: { readonly req: Request }) =>
  ctx.req.headers.has('authorization') ? { principal: { id: 'u1', email: 'a@arki.dev' } } : SignInRequired();
const admin = (ctx: { readonly principal: { readonly email: string } }) =>
  ctx.principal.email.endsWith('@arki.dev') ? { isAdmin: true as const } : NotAdmin();
const asyncAdmin = (ctx: { readonly principal: { readonly email: string } }) => Promise.resolve(admin(ctx));

const mine = route.get('/mine', { id: 'mine', output: z.string(), failures: [SignInRequired, NotAdmin] });
const signedIn = () => new Request('http://test/mine', { headers: { authorization: 'x' } });
const anonymous = () => new Request('http://test/mine');

function recorder() {
  const events: string[] = [];
  const inTransaction = async <T>(_ctx: object, next: () => Promise<T>) => {
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
  return { events, inTransaction };
}

describe('step', () => {
  it('refuses with the same response as a keyed derive and does not run the handler', async () => {
    let handled = 0;
    const handler = () => {
      handled += 1;
      return 'ok';
    };
    const engine = buildEngine([routes().use(step(authed)).bind(mine, handler)]);
    const response = await engine.fetch(anonymous());
    // The wire envelope a keyed `derive` refusal answered with, byte for byte: clients match on it.
    expect({ status: response.status, body: await response.text() }).toEqual({
      status: 401,
      body: '{"error":{"code":"test.step.sign_in","message":"test.step.sign_in"}}',
    });
    expect(handled).toBe(0);
  });

  it('hands what it returns to the handler, and later steps read earlier ones', async () => {
    const engine = buildEngine([
      routes()
        .use(step(authed))
        .use(step(asyncAdmin))
        .bind(mine, (_input, ctx) => `${ctx.principal.id}:${String(ctx.isAdmin)}`),
    ]);
    const response = await engine.fetch(signedIn());
    expect(await response.json()).toBe('u1:true');
  });

  it('stops at the first refusal, so later steps do not run', async () => {
    let later = 0;
    const engine = buildEngine([
      routes()
        .use(step(authed))
        .use(
          step(() => {
            later += 1;
            return {};
          }),
        )
        .bind(mine, () => 'ok'),
    ]);
    const response = await engine.fetch(anonymous());
    expect(response.status).toBe(401);
    expect(later).toBe(0);
  });

  // `url` and `signal` are lazy getters on the base context; a later step must still see them.
  it('keeps url and signal for steps after the first', async () => {
    const engine = buildEngine([
      routes()
        .use(step(() => ({ first: true })))
        .use(step(ctx => ({ seen: `${ctx.url.pathname}:${String(ctx.signal.aborted)}` })))
        .bind(mine, (_input, ctx) => ctx.seen),
    ]);
    const response = await engine.fetch(anonymous());
    expect(await response.json()).toBe('/mine:false');
  });

  // A 401 without a challenge leaves the client no way to sign in: the header must reach the wire.
  it('adds its failure headers to a refusal, and only to a refusal', async () => {
    const challenged = step(authed, { failureHeaders: () => ({ 'www-authenticate': 'Bearer' }) });
    const engine = buildEngine([
      routes()
        .use(challenged)
        .bind(mine, () => 'ok'),
    ]);
    const refused = await engine.fetch(anonymous());
    const allowed = await engine.fetch(signedIn());
    expect(refused.headers.get('www-authenticate')).toBe('Bearer');
    expect(allowed.headers.get('www-authenticate')).toBeNull();
  });
});

describe('around', () => {
  it('wraps later steps and the handler and passes the response through', async () => {
    const { events, inTransaction } = recorder();
    const engine = buildEngine([
      routes()
        .use(around(inTransaction))
        .use(
          step(() => {
            events.push('step');
            return { value: 'v' };
          }),
        )
        .bind(mine, (_input, ctx) => {
          events.push('handler');
          return ctx.value;
        }),
    ]);
    const response = await engine.fetch(anonymous());
    expect(await response.json()).toBe('v');
    expect(events).toEqual(['open', 'step', 'handler', 'commit']);
  });

  it('does not wrap a step declared before it', async () => {
    const { events, inTransaction } = recorder();
    const engine = buildEngine([
      routes()
        .use(
          step(() => {
            events.push('first');
            return {};
          }),
        )
        .use(around(inTransaction))
        .bind(mine, () => 'ok'),
    ]);
    await engine.fetch(anonymous());
    expect(events).toEqual(['first', 'open', 'commit']);
  });

  it('sees a refusal from a later step as a response', async () => {
    const { events, inTransaction } = recorder();
    const engine = buildEngine([
      routes()
        .use(around(inTransaction))
        .use(step(authed))
        .bind(mine, () => 'ok'),
    ]);
    const response = await engine.fetch(anonymous());
    expect(response.status).toBe(401);
    expect(events).toEqual(['open', 'commit']);
  });

  it('sees a handler error, then the caller still gets the 500 envelope', async () => {
    const { events, inTransaction } = recorder();
    const boom = route.get('/mine', { id: 'mine', output: z.string() });
    const engine = buildEngine([
      routes()
        .use(around(inTransaction))
        .bind(boom, async () => {
          await Promise.resolve();
          throw new Error('boom');
        }),
    ]);
    const response = await engine.fetch(anonymous());
    expect(response.status).toBe(500);
    expect(events).toEqual(['open', 'rollback']);
  });

  it('passes what a step declared before it added through to the handler', async () => {
    const { events, inTransaction } = recorder();
    const engine = buildEngine([
      routes()
        .use(step(() => ({ n: 1 })))
        .use(around(inTransaction))
        .bind(mine, (_input, ctx) => String(ctx.n)),
    ]);
    const response = await engine.fetch(anonymous());
    expect(await response.json()).toBe('1');
    expect(events).toEqual(['open', 'commit']);
  });
});
