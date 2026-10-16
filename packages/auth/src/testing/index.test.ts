/**
 * `actingAs` is honest: the session it makes is a real engine session, listable and revocable
 * like one from a sign-in, by cookie or (when enabled) by bearer, and it refuses in production.
 */
import { RateLimiterMemory } from 'rate-limiter-flexible';
import { describe, expect, it } from 'vitest';

import { post } from '../__fixtures__/http.js';
import { authTables } from '../__fixtures__/tables.js';
import { defineAuth } from '../definition.js';
import { AUTH_ERROR_CODES } from '../errors.js';
import { actingAs, lastMagicLink, testAuth } from './index.js';

const definition = defineAuth({
  app: { name: 'Notes', key: 'notes' },
  methods: ['password', 'magicLink'],
  user: { fields: ['plan'] },
  sessions: { bearer: true },
});

describe('actingAs', () => {
  it('makes a real session that is listed and can be revoked', async () => {
    const { auth, dispose } = await testAuth(definition, { tables: authTables });
    try {
      const { headers, user } = await actingAs(auth, { email: 'Ada@Notes.test', plan: 'pro' });
      expect(user).toMatchObject({ email: 'ada@notes.test', plan: 'pro', emailVerified: true });
      const principal = await auth.principal(headers);
      if (principal === null) throw new Error('expected a principal');
      expect(await auth.sessions.list(principal)).toEqual([
        expect.objectContaining({ id: principal.session.id, current: true }),
      ]);
      await auth.sessions.revoke(principal, principal.session.id);
      expect(await auth.principal(headers)).toBeNull();
    } finally {
      await dispose();
    }
  });

  it('reuses an existing user and signs in by bearer when enabled', async () => {
    const { auth, dispose } = await testAuth(definition, { tables: authTables });
    try {
      const first = await actingAs(auth, { email: 'ada@notes.test' });
      const second = await actingAs(auth, { email: 'ada@notes.test' }, { via: 'bearer' });
      expect(second.user.id).toBe(first.user.id);
      expect(second.headers.get('authorization')).toMatch(/^Bearer /);
      await expect(auth.principal(second.headers)).resolves.toMatchObject({ via: 'bearer' });
    } finally {
      await dispose();
    }
  });

  it('refuses in production (E005)', async () => {
    const { rebuild, dispose } = await testAuth(definition, { tables: authTables });
    try {
      const production = rebuild({
        rateLimit: { store: { getRateLimiter: () => new RateLimiterMemory({ points: 100, duration: 10 }) } },
        runtime: { production: true },
      });
      await expect(actingAs(production, { email: 'ada@notes.test' })).rejects.toMatchObject({
        code: AUTH_ERROR_CODES.testingInProduction,
      });
    } finally {
      await dispose();
    }
  });

  it('gives a seeded user a password that signs in through the form, and replaces it on the next call', async () => {
    // Form-driven E2E specs sign in with a known password; a stale one from an earlier run must not survive.
    const { auth, dispose } = await testAuth(definition, { tables: authTables });
    const signIn = (password: string) => post(auth, '/sign-in/email', { email: 'ada@notes.test', password });
    try {
      await actingAs(auth, { email: 'ada@notes.test' }, { password: 'e2e-test-password-1234' });
      await expect(signIn('e2e-test-password-1234')).resolves.toHaveProperty('status', 200);

      await actingAs(auth, { email: 'ada@notes.test' }, { password: 'another-password-5678' });
      await expect(signIn('e2e-test-password-1234')).resolves.toHaveProperty('status', 401);
      await expect(signIn('another-password-5678')).resolves.toHaveProperty('status', 200);
    } finally {
      await dispose();
    }
  });

  it('refuses a password when the definition has no password method (E001)', async () => {
    const magicOnly = defineAuth({ app: { name: 'Notes', key: 'notes' }, methods: ['magicLink'] });
    const { auth, dispose } = await testAuth(magicOnly, { tables: authTables });
    try {
      await expect(
        actingAs(auth, { email: 'ada@notes.test' }, { password: 'e2e-test-password-1234' }),
      ).rejects.toMatchObject({ code: AUTH_ERROR_CODES.invalidConfig });
    } finally {
      await dispose();
    }
  });
});

describe('lastMagicLink', () => {
  it('returns the link of the latest magic-link mail, and throws when none was sent', async () => {
    const { auth, mail, dispose } = await testAuth(definition, { tables: authTables });
    try {
      expect(() => lastMagicLink(mail, 'ada@notes.test')).toThrow();
      await auth.handler(
        new Request('http://localhost:3000/api/auth/sign-in/magic-link', {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
          body: JSON.stringify({ email: 'ada@notes.test' }),
        }),
      );
      expect(lastMagicLink(mail, 'ada@notes.test').pathname).toBe('/api/auth/magic-link/verify');
    } finally {
      await dispose();
    }
  });
});
