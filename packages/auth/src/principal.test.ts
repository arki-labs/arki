/**
 * One identity per request, failures never become guests, and the principal carries exactly the
 * columns the definition exposes.
 */
import { describe, expect, it } from 'vitest';

import { authTables } from './__fixtures__/tables.js';
import { defineAuth } from './definition.js';
import { AUTH_ERROR_CODES } from './errors.js';
import { toUserRow } from './principal.js';
import { actingAs, testAuth } from './testing/index.js';

const definition = defineAuth({
  app: { name: 'Notes', key: 'notes' },
  methods: ['password'],
  user: { fields: ['plan'] },
  sessions: { bearer: true },
});

describe('auth.principal', () => {
  it('resolves the same principal from a bearer token as from the cookie', async () => {
    const { auth, dispose } = await testAuth(definition, { tables: authTables });
    try {
      const byCookie = await actingAs(auth, { email: 'ada@notes.test' });
      const byBearer = await actingAs(auth, { email: 'ada@notes.test' }, { via: 'bearer' });
      const fromCookie = await auth.principal(byCookie.headers);
      const fromBearer = await auth.principal(byBearer.headers);
      expect(fromCookie?.via).toBe('cookie');
      expect(fromBearer?.via).toBe('bearer');
      expect(fromBearer?.user).toEqual(fromCookie?.user);
    } finally {
      await dispose();
    }
  });

  it('refuses a request that carries a cookie and a bearer token (E401)', async () => {
    const { auth, dispose } = await testAuth(definition, { tables: authTables });
    try {
      const ada = await actingAs(auth, { email: 'ada@notes.test' });
      const eve = await actingAs(auth, { email: 'eve@notes.test' }, { via: 'bearer' });
      const both = new Headers(ada.headers);
      both.set('authorization', eve.headers.get('authorization') ?? '');
      await expect(auth.principal(both)).rejects.toMatchObject({ code: AUTH_ERROR_CODES.unauthenticated });
    } finally {
      await dispose();
    }
  });

  it('fails when the roles resolver fails; it never answers a guest', async () => {
    const { auth, dispose } = await testAuth(definition, {
      tables: authTables,
      roles: () => Promise.reject(new Error('roles table is down')),
    });
    try {
      const { headers } = await actingAs(auth, { email: 'ada@notes.test' });
      await expect(auth.principal(headers)).rejects.toThrow('roles table is down');
    } finally {
      await dispose();
    }
  });

  it('carries the roles the resolver returns for the narrowed user', async () => {
    const { auth, dispose } = await testAuth(definition, {
      tables: authTables,
      roles: user => (user.plan === 'pro' ? ['admin'] : []),
    });
    try {
      const pro = await actingAs(auth, { email: 'ada@notes.test', plan: 'pro' });
      const free = await actingAs(auth, { email: 'eve@notes.test' });
      await expect(auth.principal(pro.headers)).resolves.toMatchObject({ roles: ['admin'] });
      await expect(auth.principal(free.headers)).resolves.toMatchObject({ roles: [] });
    } finally {
      await dispose();
    }
  });

  it('has every exposed column and none of the hidden ones', async () => {
    const { auth, dispose } = await testAuth(definition, { tables: authTables });
    try {
      const { headers } = await actingAs(auth, { email: 'ada@notes.test', plan: 'pro' });
      const principal = await auth.principal(headers);
      expect(principal?.user.plan).toBe('pro');
      expect(new Set(Object.keys(principal?.user ?? {}))).toEqual(
        new Set(['createdAt', 'email', 'emailVerified', 'id', 'image', 'name', 'plan', 'updatedAt']),
      );
    } finally {
      await dispose();
    }
  });
});

describe('toUserRow', () => {
  const engineUser = {
    id: 'usr_1',
    name: 'Ada',
    email: 'ada@notes.test',
    emailVerified: true,
    image: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    plan: 'pro',
    stripeCustomerId: 'cus_secret',
  };

  it('keeps the core and exposed columns only', () => {
    expect(toUserRow(engineUser, ['plan'])).not.toHaveProperty('stripeCustomerId');
  });

  it('refuses an engine user that lacks an exposed column (E004)', () => {
    const { plan: _plan, ...withoutPlan } = engineUser;
    expect(() => toUserRow(withoutPlan, ['plan'])).toThrow(
      expect.objectContaining({ code: AUTH_ERROR_CODES.principalShape }),
    );
  });

  it('refuses a core column of the wrong type (E004)', () => {
    expect(() => toUserRow({ ...engineUser, emailVerified: 'yes' }, [])).toThrow(
      expect.objectContaining({ code: AUTH_ERROR_CODES.principalShape }),
    );
  });
});
