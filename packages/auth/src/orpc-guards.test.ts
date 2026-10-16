/**
 * The oRPC guards on real principals: a guest is UNAUTHORIZED (E401), a member is FORBIDDEN from
 * an admin procedure (E403) while an admin passes, and an unverified user is FORBIDDEN where
 * verification is required.
 */
import { call, ORPCError, os } from '@orpc/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PrincipalFor } from './pg/types.js';
import type { TestAuth } from './testing/index.js';
import { authTables } from './__fixtures__/tables.js';
import { defineAuth } from './definition.js';
import { AUTH_ERROR_CODES } from './errors.js';
import { guards } from './orpc.js';
import { actingAs, testAuth } from './testing/index.js';

const definition = defineAuth({
  app: { name: 'Notes', key: 'notes' },
  methods: ['password'],
  user: { fields: ['plan'] },
});
type Context = { readonly principal: PrincipalFor<typeof definition, typeof authTables> | null };

const { authed, verified, role } = guards<Context>();
const base = os.$context<Context>();
const me = base.use(authed).handler(({ context }) => context.principal.user.email);
const settings = base.use(verified).handler(({ context }) => context.principal.user.id);
const adminStats = base.use(role('admin')).handler(({ context }) => context.principal.roles);

let harness: TestAuth<typeof definition, typeof authTables>;
beforeAll(async () => {
  harness = await testAuth(definition, { tables: authTables, roles: user => (user.plan === 'pro' ? ['admin'] : []) });
});
afterAll(() => harness.dispose());

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

describe('guards', () => {
  it('authed: a guest is UNAUTHORIZED with E401; a member passes', async () => {
    expect(await failureOf(() => call(me, undefined, { context: { principal: null } }))).toEqual({
      code: 'UNAUTHORIZED',
      data: { code: AUTH_ERROR_CODES.unauthenticated },
    });
    const principal = await principalFor('ada@notes.test');
    expect(await call(me, undefined, { context: { principal } })).toBe('ada@notes.test');
  });

  it("role('admin'): a member is FORBIDDEN with E403; an admin passes", async () => {
    const member = await principalFor('eve@notes.test');
    expect(await failureOf(() => call(adminStats, undefined, { context: { principal: member } }))).toEqual({
      code: 'FORBIDDEN',
      data: { code: AUTH_ERROR_CODES.forbidden },
    });
    const admin = await principalFor('root@notes.test', { plan: 'pro' });
    expect(await call(adminStats, undefined, { context: { principal: admin } })).toEqual(['admin']);
  });

  it('verified: an unverified user is FORBIDDEN with E403; a verified one passes', async () => {
    const unverified = await principalFor('new@notes.test', { emailVerified: false });
    expect(await failureOf(() => call(settings, undefined, { context: { principal: unverified } }))).toEqual({
      code: 'FORBIDDEN',
      data: { code: AUTH_ERROR_CODES.forbidden },
    });
    const verifiedUser = await principalFor('ada@notes.test');
    expect(await call(settings, undefined, { context: { principal: verifiedUser } })).toMatch(/^usr_/);
  });
});
