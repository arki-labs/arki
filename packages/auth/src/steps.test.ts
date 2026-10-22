/**
 * The principal steps on real principals: a guest is refused with 401 (`auth.unauthenticated`), a
 * member is refused with 403 (`auth.forbidden`) where a role or a verified email is required, and a
 * signed-in caller gets `{ principal }`. The same functions run bare, through an `@arki/http`
 * bundle and through oRPC, so one declaration serves every transport.
 */
import { call, ORPCError, os } from '@orpc/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { step as rpcStep } from '@arki/dot/orpc';
import { errorMap, reviveRpcError } from '@arki/failure/orpc';
import { buildEngine, step as httpStep, route, routes } from '@arki/http';

import type { PrincipalFor } from './pg/types.js';
import type { TestAuth } from './testing/index.js';
import { authTables } from './__fixtures__/tables.js';
import { AccessDenied, AUTH_FAILURES, AuthenticationRequired } from './boundary-failures.js';
import { defineAuth } from './definition.js';
import { authFailureHeaders, principalFromHeaders } from './http.js';
import { authed, role, verified } from './steps.js';
import { actingAs, testAuth } from './testing/index.js';

const definition = defineAuth({
  app: { name: 'Notes', key: 'notes' },
  methods: ['password'],
  user: { fields: ['plan'] },
});
type Context = { readonly principal: PrincipalFor<typeof definition, typeof authTables> | null };

const base = os.$context<Context>().errors(errorMap(...AUTH_FAILURES));
const me = base.use(rpcStep(authed)).handler(({ context }) => context.principal.user.email);
const settings = base.use(rpcStep(verified)).handler(({ context }) => context.principal.user.id);
const adminStats = base.use(rpcStep(role('admin'))).handler(({ context }) => context.principal.roles);

const meRoute = route.get('/me', { failures: AUTH_FAILURES, id: 'me', output: z.object({ email: z.string() }) });
const adminRoute = route.get('/admin', { failures: AUTH_FAILURES, id: 'admin', output: z.object({ ok: z.boolean() }) });

let harness: TestAuth<typeof definition, typeof authTables>;
let fetchHttp: (request: Request) => Promise<Response>;
beforeAll(async () => {
  harness = await testAuth(definition, { tables: authTables, roles: user => (user.plan === 'pro' ? ['admin'] : []) });
  const { auth } = harness;
  const engine = buildEngine([
    routes()
      .use(httpStep(principalFromHeaders(auth), { failureHeaders: authFailureHeaders }))
      .use(httpStep(authed, { failureHeaders: authFailureHeaders }))
      .bind(meRoute, (_input, ctx) => ({ email: ctx.principal.user.email })),
    routes()
      .use(httpStep(principalFromHeaders(auth), { failureHeaders: authFailureHeaders }))
      .use(httpStep(role('admin'), { failureHeaders: authFailureHeaders }))
      .bind(adminRoute, () => ({ ok: true })),
  ]);
  fetchHttp = request => Promise.resolve(engine.fetch(request));
});
afterAll(() => harness.dispose());

const request = (path: string, headers?: Headers) => fetchHttp(new Request(`http://localhost${path}`, { headers }));

async function principalFor(email: string, extra: { plan?: 'free' | 'pro'; emailVerified?: boolean } = {}) {
  const { headers } = await actingAs(harness.auth, { email, ...extra });
  return harness.auth.principal(headers);
}

async function failureOf(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    if (error instanceof ORPCError) return { code: error.code, data: error.data };
    throw error;
  }
  return;
}

describe('steps, called directly', () => {
  it('authed: a guest is refused with E401; a member gets { principal }', async () => {
    expect(AuthenticationRequired.is(authed({ principal: null }))).toBe(true);
    const principal = await principalFor('ada@notes.test');
    expect(authed({ principal })).toEqual({ principal });
  });

  it('verified: a guest is E401, an unverified user E403, a verified user passes', async () => {
    expect(AuthenticationRequired.is(verified({ principal: null }))).toBe(true);
    const unverified = await principalFor('new@notes.test', { emailVerified: false });
    expect(AccessDenied.is(verified({ principal: unverified }))).toBe(true);
    const ok = await principalFor('ada@notes.test');
    expect(verified({ principal: ok })).toEqual({ principal: ok });
  });

  it("role('admin'): a guest is E401, a member E403, an admin passes", async () => {
    const check = role('admin');
    expect(AuthenticationRequired.is(check({ principal: null }))).toBe(true);
    const member = await principalFor('eve@notes.test');
    expect(AccessDenied.is(check({ principal: member }))).toBe(true);
    const admin = await principalFor('root@notes.test', { plan: 'pro' });
    expect(check({ principal: admin })).toEqual({ principal: admin });
  });
});

describe('steps through @arki/http', () => {
  it('a guest gets 401 with a challenge; a signed-in caller reaches the handler', async () => {
    const guest = await request('/me');
    expect(guest.status).toBe(401);
    expect(guest.headers.get('www-authenticate')).toBe('Bearer');
    const { headers } = await actingAs(harness.auth, { email: 'ada@notes.test' });
    await expect(request('/me', headers).then(response => response.json())).resolves.toEqual({
      email: 'ada@notes.test',
    });
  });

  it('a missing role gets 403; the role passes', async () => {
    const member = await actingAs(harness.auth, { email: 'eve@notes.test' });
    const refused = await request('/admin', member.headers);
    expect(refused.status).toBe(403);
    const root = await actingAs(harness.auth, { email: 'root@notes.test', plan: 'pro' });
    const allowed = await request('/admin', root.headers);
    expect(allowed.status).toBe(200);
  });
});

describe('steps through oRPC', () => {
  it('authed: a guest is UNAUTHORIZED with E401; a member passes', async () => {
    expect(await failureOf(() => call(me, undefined, { context: { principal: null } }))).toEqual({
      code: 'auth.unauthenticated',
      data: undefined,
    });
    const principal = await principalFor('ada@notes.test');
    expect(await call(me, undefined, { context: { principal } })).toBe('ada@notes.test');
  });

  it("role('admin'): a member is FORBIDDEN with E403; an admin passes", async () => {
    const member = await principalFor('eve@notes.test');
    expect(await failureOf(() => call(adminStats, undefined, { context: { principal: member } }))).toEqual({
      code: 'auth.forbidden',
      data: undefined,
    });
    const admin = await principalFor('root@notes.test', { plan: 'pro' });
    expect(await call(adminStats, undefined, { context: { principal: admin } })).toEqual(['admin']);
  });

  it('verified: an unverified user is FORBIDDEN with E403; a verified one passes', async () => {
    const unverified = await principalFor('new@notes.test', { emailVerified: false });
    expect(await failureOf(() => call(settings, undefined, { context: { principal: unverified } }))).toEqual({
      code: 'auth.forbidden',
      data: undefined,
    });
    const verifiedUser = await principalFor('ada@notes.test');
    expect(await call(settings, undefined, { context: { principal: verifiedUser } })).toMatch(/^usr_/);
  });

  it('declared oRPC auth failures revive as the canonical browser failure', async () => {
    const error: unknown = await call(me, undefined, { context: { principal: null } }).catch(
      (error_: unknown) => error_,
    );
    expect(AuthenticationRequired.is(reviveRpcError(error, AUTH_FAILURES))).toBe(true);
  });
});
