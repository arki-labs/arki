/**
 * `step` and `around` (`@arki/http`) at runtime.
 *
 * Why these tests exist: a step is the new way to do what a keyed `derive` did, so its refusal must
 * be byte-for-byte the same response as a `derive` refusal, and the handler must not run. What a step
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
import { derive } from '../derive.js';
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
    const viaStep = buildEngine([routes().use(step(authed)).bind(mine, handler)]);
    const viaDerive = buildEngine([
      routes()
        .derive('principal', (req: Request) => (req.headers.has('authorization') ? { id: 'u1' } : SignInRequired()))
        .bind(mine, handler),
    ]);
    const a = await viaStep.fetch(anonymous());
    const b = await viaDerive.fetch(anonymous());
    expect(a.status).toBe(401);
    expect({ status: a.status, body: await a.text() }).toEqual({ status: b.status, body: await b.text() });
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

  it('works with a keyed derive in the same bundle', async () => {
    const { events, inTransaction } = recorder();
    const engine = buildEngine([
      routes()
        .derive(derive('n', () => 1))
        .use(around(inTransaction))
        .bind(mine, (_input, ctx) => String(ctx.n)),
    ]);
    const response = await engine.fetch(anonymous());
    expect(await response.json()).toBe('1');
    expect(events).toEqual(['open', 'commit']);
  });
});
