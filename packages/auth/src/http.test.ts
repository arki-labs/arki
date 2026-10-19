import { eq } from 'drizzle-orm';
/**
 * The principal over `@arki/http`, through a real `routes()` bundle: a guest gets 401, a refused
 * check 403, an optional route sees `null`, and the http transport sees the same principal the
 * auth (and so oRPC) resolves.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { buildEngine, route, routes } from '@arki/http';
import { createClient } from '@arki/http/client';

import type { TestAuth } from './testing/index.js';
import { authTables } from './__fixtures__/tables.js';
import { AccessDenied, AUTH_FAILURES, AuthenticationRequired } from './boundary-failures.js';
import { defineAuth } from './definition.js';
import { AUTH_ERROR_CODES, AuthError } from './errors.js';
import { withOptionalPrincipal, withPrincipal } from './http.js';
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
      .derive(withPrincipal(auth))
      .bind(me, (_input, ctx) => ({ id: ctx.principal.user.id, plan: ctx.principal.user.plan })),
    routes()
      .derive(withPrincipal(auth, { role: 'admin' }))
      .bind(admin, () => ({ ok: true })),
    routes()
      .derive(withOptionalPrincipal(auth))
      .bind(greeting, (_input, ctx) => ({ who: ctx.principal?.user.email ?? 'guest' })),
  ]);
  fetchHttp = request => Promise.resolve(engine.fetch(request));
});
afterAll(() => harness.dispose());

const request = (path: string, headers?: Headers) => fetchHttp(new Request(`http://localhost${path}`, { headers }));

describe('withPrincipal', () => {
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

describe('withOptionalPrincipal', () => {
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

  it('the principal deriver preserves limiter Retry-After without publishing its cause', async () => {
    const engine = buildEngine([
      routes()
        .derive(
          withPrincipal({
            principal: () =>
              Promise.reject(new AuthError(AUTH_ERROR_CODES.rateLimited, 'private limiter detail', { retryAfter: 7 })),
          }),
        )
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
