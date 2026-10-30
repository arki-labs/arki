import { eq } from 'drizzle-orm';
/**
 * The principal over `@arki/http`, through a real `routes()` bundle: a guest gets 401, a refused
 * check 403, an optional route sees `null`, and the http transport sees the same principal the
 * auth (and so oRPC) resolves.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { serialize } from '@arki/failure';
import { buildEngine, route, routes, step } from '@arki/http';
import { createClient } from '@arki/http/client';

import type { TestAuth } from './testing/index.js';
import { authTables } from './__fixtures__/tables.js';
import { AccessDenied, AUTH_FAILURES, AuthenticationRequired, checkPrincipal, requirePrincipal, resolvePrincipal } from './boundary-failures.js';
import { defineAuth } from './definition.js';
import { AUTH_ERROR_CODES, AuthError } from './errors.js';
import { authFailureHeaders, principalFromHeaders } from './http.js';
import { authed, role } from './steps.js';
import { actingAs, testAuth } from './testing/index.js';

const definition = defineAuth({
  app: { name: 'Notes', key: 'notes' },
  methods: ['password'],
  user: { fields: ['plan'] },
  sessions: { bearer: true },
});

const me = route.get('/me', {
  failures: AUTH_FAILURES,
  id: 'me',
  output: z.object({ id: z.string(), plan: z.string() }),
});
const admin = route.get('/admin', { failures: AUTH_FAILURES, id: 'admin', output: z.object({ ok: z.boolean() }) });
const greeting = route.get('/greeting', {
  failures: AUTH_FAILURES,
  id: 'greeting',
  output: z.object({ who: z.string() }),
});

let harness: TestAuth<typeof definition, typeof authTables>;
let fetchHttp: (request: Request) => Promise<Response>;
beforeAll(async () => {
  harness = await testAuth(definition, { tables: authTables, roles: user => (user.plan === 'pro' ? ['admin'] : []) });
  const { auth } = harness;
  const engine = buildEngine([
    routes()
      .use(step(principalFromHeaders(auth), { failureHeaders: authFailureHeaders }))
      .use(step(authed, { failureHeaders: authFailureHeaders }))
      .bind(me, (_input, ctx) => ({ id: ctx.principal.user.id, plan: ctx.principal.user.plan })),
    routes()
      .use(step(principalFromHeaders(auth), { failureHeaders: authFailureHeaders }))
      .use(step(role('admin'), { failureHeaders: authFailureHeaders }))
      .bind(admin, () => ({ ok: true })),
    routes()
      .use(step(principalFromHeaders(auth), { failureHeaders: authFailureHeaders }))
      .bind(greeting, (_input, ctx) => ({ who: ctx.principal?.user.email ?? 'guest' })),
  ]);
  fetchHttp = request => Promise.resolve(engine.fetch(request));
});
afterAll(() => harness.dispose());

const request = (path: string, headers?: Headers) => fetchHttp(new Request(`http://localhost${path}`, { headers }));

describe('principalFromHeaders with authed', () => {
  it('answers 401 with E401 for a guest', async () => {
    const response = await request('/me');
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: AuthenticationRequired.code } });
  });

  it('sees the same principal the auth resolves, by cookie and by bearer', async () => {
    const byCookie = await actingAs(harness.auth, { email: 'ada@notes.test', plan: 'pro' });
    const byBearer = await actingAs(harness.auth, { email: 'ada@notes.test' }, { via: 'bearer' });
    const principal = await harness.auth.principal(byCookie.headers);
    await expect(request('/me', byCookie.headers).then(response => response.json())).resolves.toEqual({
      id: principal?.user.id,
      plan: 'pro',
    });
    await expect(request('/me', byBearer.headers).then(response => response.json())).resolves.toEqual({
      id: principal?.user.id,
      plan: 'pro',
    });
  });

  it('answers 403 with E403 when the role is missing, and passes with it', async () => {
    const member = await actingAs(harness.auth, { email: 'eve@notes.test' });
    const refused = await request('/admin', member.headers);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: { code: AccessDenied.code } });
    const root = await actingAs(harness.auth, { email: 'root@notes.test', plan: 'pro' });
    await expect(request('/admin', root.headers)).resolves.toHaveProperty('status', 200);
  });

  it('answers 401 with E401 for a cookie and a bearer token together', async () => {
    const ada = await actingAs(harness.auth, { email: 'ada@notes.test' });
    const eve = await actingAs(harness.auth, { email: 'eve@notes.test' }, { via: 'bearer' });
    const both = new Headers(ada.headers);
    both.set('authorization', eve.headers.get('authorization') ?? '');
    const response = await request('/me', both);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: AuthenticationRequired.code } });
  });
});

describe('principalFromHeaders alone', () => {
  it('gives null to a guest and the principal to a signed-in caller', async () => {
    await expect(request('/greeting').then(response => response.json())).resolves.toEqual({ who: 'guest' });
    const { headers } = await actingAs(harness.auth, { email: 'ada@notes.test' });
    await expect(request('/greeting', headers).then(response => response.json())).resolves.toEqual({
      who: 'ada@notes.test',
    });
  });
});

describe('canonical auth boundaries', () => {
  it('expired PGlite sessions answer 401 with a challenge and revive on the Arki client', async () => {
    const session = await actingAs(harness.auth, { email: 'expired@notes.test' });
    await harness.db
      .update(authTables.Session)
      .set({ expiresAt: new Date(0) })
      .where(eq(authTables.Session.userId, session.user.id));
    const response = await request('/me', session.headers);
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
    const client = createClient(me, {
      baseUrl: 'http://localhost',
      fetch: (input, init) => fetchHttp(new Request(input, init)),
    });
    const failure = await client(undefined, { headers: Object.fromEntries(session.headers) });
    expect(AuthenticationRequired.is(failure)).toBe(true);
  });

  it('the principal step preserves limiter Retry-After without publishing its cause', async () => {
    const engine = buildEngine([
      routes()
        .use(
          step(
            principalFromHeaders({
              principal: () =>
                Promise.reject(
                  new AuthError(AUTH_ERROR_CODES.rateLimited, 'private limiter detail', { retryAfter: 7 }),
                ),
            }),
            { failureHeaders: authFailureHeaders },
          ),
        )
        .use(step(authed, { failureHeaders: authFailureHeaders }))
        .bind(me, (_input, ctx) => ({ id: ctx.principal.user.id, plan: 'free' })),
    ]);
    const response = await engine.fetch(new Request('http://localhost/me'));
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('7');
    expect(await response.json()).toEqual({
      error: {
        code: 'auth.rate_limited',
        message: 'Too many authentication attempts.',
        data: { retryAfter: 7 },
      },
    });
  });
});

describe('resolvePrincipal on the error a principal source throws', () => {
  const failWith = (error: unknown) => resolvePrincipal({ principal: () => Promise.reject(error) }, new Headers());

  it('a store outage is auth.unavailable (503) and keeps its private cause off the failure data', async () => {
    const outage = new AuthError(AUTH_ERROR_CODES.storeUnavailable, 'pg host db-7 refused');
    const failure = await failWith(outage);
    expect(failure).toMatchObject({ code: 'auth.unavailable', status: 503 });
    expect(JSON.stringify(serialize(failure, AUTH_FAILURES))).not.toContain('db-7');
  });

  it('an unknown error is failure.unexpected_defect, never a signed-out answer', async () => {
    expect(await failWith(new Error('boom'))).toMatchObject({ code: 'failure.unexpected_defect' });
  });

  it('an expired session is auth.unauthenticated (401) and a revoked right is auth.forbidden (403)', async () => {
    expect(await failWith(new AuthError(AUTH_ERROR_CODES.unauthenticated, 'expired'))).toMatchObject({
      code: 'auth.unauthenticated',
    });
    expect(await failWith(new AuthError(AUTH_ERROR_CODES.forbidden, 'no'))).toMatchObject({ code: 'auth.forbidden' });
  });
});

describe('requirePrincipal and checkPrincipal return the failure as a value', () => {
  const principal = { user: { id: 'usr_1', emailVerified: false }, roles: ['member'] } as unknown as Parameters<
    typeof checkPrincipal
  >[0];

  it('a missing principal is auth.unauthenticated (401) from both', () => {
    expect(requirePrincipal(null)).toMatchObject({ code: 'auth.unauthenticated', status: 401 });
    expect(checkPrincipal(null)).toMatchObject({ code: 'auth.unauthenticated', status: 401 });
  });

  it('an unverified email or a missing role is auth.forbidden (403), and a passing principal comes back as is', () => {
    expect(checkPrincipal(principal, { verified: true })).toMatchObject({ code: 'auth.forbidden', status: 403 });
    expect(checkPrincipal(principal, { role: 'admin' })).toMatchObject({ code: 'auth.forbidden', status: 403 });
    expect(checkPrincipal(principal, { role: 'member' })).toBe(principal);
    expect(requirePrincipal(principal)).toBe(principal);
  });
});
