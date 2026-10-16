/**
 * Events are additive and redacted: they tell the app what happened (method, reason) without
 * tokens, cookies or passwords, and an observer bug can never change what the user gets back.
 * `beforeUserCreate` is the one hook that can refuse (avocabo's waitlist).
 */
import { describe, expect, it } from 'vitest';

import type { AuthEvents } from './types.js';
import { cookiesOf, PASSWORD, post } from '../__fixtures__/http.js';
import { authTables } from '../__fixtures__/tables.js';
import { defineAuth } from '../definition.js';
import { AUTH_ERROR_CODES, AuthError } from '../errors.js';
import { testAuth } from '../testing/index.js';

const open = defineAuth({ app: { name: 'Notes', key: 'notes' }, methods: ['password'], verifyEmail: 'none' });
const strict = defineAuth({ app: { name: 'Notes', key: 'notes' }, methods: ['password'] });

const boom = () => {
  throw new Error('observer bug');
};

type Recorded = { readonly name: string; readonly event: unknown };

function recorder() {
  const events: Recorded[] = [];
  const record =
    (name: string) =>
    (event: unknown): void => {
      events.push({ name, event });
    };
  const on = {
    userCreated: record('userCreated'),
    signIn: record('signIn'),
    signInFailed: record('signInFailed'),
    passwordChanged: record('passwordChanged'),
    signOut: record('signOut'),
  } satisfies AuthEvents<unknown, unknown>;
  return { events, on, named: (name: string) => events.filter(entry => entry.name === name).map(entry => entry.event) };
}

describe('auth events', () => {
  it('report sign-up, sign-in, failure, password change and sign-out with their method', async () => {
    const { events, on, named } = recorder();
    const { auth, dispose } = await testAuth(open, { tables: authTables, on });
    try {
      const signUp = await post(auth, '/sign-up/email', { email: 'ada@notes.test', password: PASSWORD, name: 'Ada' });
      const cookie = cookiesOf(signUp);
      expect(named('userCreated')).toEqual([
        expect.objectContaining({ method: 'password', user: expect.objectContaining({ email: 'ada@notes.test' }) }),
      ]);
      expect(named('signIn')).toEqual([expect.objectContaining({ method: 'password', requestId: expect.any(String) })]);

      await post(auth, '/sign-in/email', { email: 'ada@notes.test', password: 'wrong password!' });
      expect(named('signInFailed')).toEqual([expect.objectContaining({ method: 'password', reason: 'credentials' })]);

      const changed = await post(
        auth,
        '/change-password',
        { currentPassword: PASSWORD, newPassword: `${PASSWORD}!` },
        { cookie },
      );
      expect(changed.status).toBe(200);
      expect(named('passwordChanged')).toEqual([
        expect.objectContaining({ reason: 'change', userId: expect.stringMatching(/^usr_/) }),
      ]);

      const signedOut = await post(auth, '/sign-out', {}, { cookie: cookiesOf(changed) || cookie });
      expect(signedOut.status).toBe(200);
      expect(named('signOut')).toHaveLength(1);

      const serialized = JSON.stringify(events);
      expect(serialized).not.toContain(PASSWORD);
      expect(serialized).not.toContain('session_token');
      expect(serialized).not.toMatch(/"token"/);
    } finally {
      await dispose();
    }
  });

  it('report an unverified sign-in as `unverified`', async () => {
    const { on, named } = recorder();
    const { auth, dispose } = await testAuth(strict, { tables: authTables, on });
    try {
      await post(auth, '/sign-up/email', { email: 'ada@notes.test', password: PASSWORD, name: 'Ada' });
      const refused = await post(auth, '/sign-in/email', { email: 'ada@notes.test', password: PASSWORD });
      expect(refused.status).toBe(403);
      expect(named('signInFailed')).toEqual([expect.objectContaining({ reason: 'unverified' })]);
      expect(named('signIn')).toHaveLength(0);
    } finally {
      await dispose();
    }
  });

  it('a throwing observer does not change the response', async () => {
    const { auth, dispose } = await testAuth(open, { tables: authTables, on: { signIn: boom, userCreated: boom } });
    try {
      const response = await post(auth, '/sign-up/email', { email: 'ada@notes.test', password: PASSWORD, name: 'Ada' });
      expect(response.status).toBe(200);
      expect(await auth.principal(new Headers({ cookie: cookiesOf(response) }))).not.toBeNull();
    } finally {
      await dispose();
    }
  });

  it('`beforeUserCreate` throwing AuthError refuses the sign-up with that code', async () => {
    const { auth, dispose } = await testAuth(open, {
      tables: authTables,
      on: {
        beforeUserCreate: ({ email, method }) => {
          if (method === 'password' && !email.endsWith('@invited.test')) {
            throw new AuthError(AUTH_ERROR_CODES.forbidden, 'Not on the waitlist yet.');
          }
        },
      },
    });
    try {
      const refused = await post(auth, '/sign-up/email', { email: 'eve@notes.test', password: PASSWORD, name: 'Eve' });
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({
        code: AUTH_ERROR_CODES.forbidden,
        message: 'Not on the waitlist yet.',
      });
      const second = await post(auth, '/sign-in/email', { email: 'eve@notes.test', password: PASSWORD });
      expect(second.status).toBe(401);

      const invited = await post(auth, '/sign-up/email', {
        email: 'ada@invited.test',
        password: PASSWORD,
        name: 'Ada',
      });
      expect(invited.status).toBe(200);
    } finally {
      await dispose();
    }
  });
});
