/**
 * The password path through the real engine with the injected mailer: sign up, verify by mail,
 * sign in, reset, change. Each step's security property is asserted, not just its status.
 */
import { describe, expect, it } from 'vitest';

import { resetPassword, verifyEmail } from '@arki/mail/templates/auth';

import { cookiesOf, get, PASSWORD, post } from '../../__fixtures__/http.js';
import { authTables } from '../../__fixtures__/tables.js';
import { defineAuth } from '../../definition.js';
import { actingAs, lastLink, testAuth } from '../../testing/index.js';

const NEW_PASSWORD = 'tr0ub4dor & 3 more words';
const requireVerified = defineAuth({ app: { name: 'Notes', key: 'notes' }, methods: ['password'] });
const sendOnly = defineAuth({ app: { name: 'Notes', key: 'notes' }, methods: ['password'], verifyEmail: 'send' });

const signUp = (auth: Parameters<typeof post>[0]) =>
  post(auth, '/sign-up/email', { email: 'ada@notes.test', password: PASSWORD, name: 'Ada' });
const signIn = (auth: Parameters<typeof post>[0], password = PASSWORD) =>
  post(auth, '/sign-in/email', { email: 'ada@notes.test', password });

describe('password sign-up and verification', () => {
  it('signs up, verifies by mail, then signs in', async () => {
    const { auth, mail, dispose } = await testAuth(requireVerified, { tables: authTables });
    try {
      await expect(signUp(auth)).resolves.toHaveProperty('status', 200);
      expect(mail.sentWith(verifyEmail)).toHaveLength(1);

      const verified = await get(auth, lastLink(mail, verifyEmail, 'ada@notes.test'));
      expect(verified.status).toBeLessThan(400);
      const session = await auth.principal(new Headers({ cookie: cookiesOf(verified) }));
      expect(session?.user.emailVerified).toBe(true);

      await expect(signIn(auth)).resolves.toHaveProperty('status', 200);
    } finally {
      await dispose();
    }
  });

  it("'require' refuses sign-in until the link is used", async () => {
    const { auth, dispose } = await testAuth(requireVerified, { tables: authTables });
    try {
      const created = await signUp(auth);
      expect(cookiesOf(created)).not.toContain('session_token=');
      await expect(signIn(auth)).resolves.toHaveProperty('status', 403);
    } finally {
      await dispose();
    }
  });

  it("'send' mails the link and lets the user in before it is used", async () => {
    const { auth, mail, dispose } = await testAuth(sendOnly, { tables: authTables });
    try {
      const created = await signUp(auth);
      expect(mail.sentWith(verifyEmail)).toHaveLength(1);
      expect(await auth.principal(new Headers({ cookie: cookiesOf(created) }))).not.toBeNull();
      await expect(signIn(auth)).resolves.toHaveProperty('status', 200);
    } finally {
      await dispose();
    }
  });
});

describe('password reset and change', () => {
  it('a reset changes the password, revokes every session and sends one mail', async () => {
    const { auth, mail, dispose } = await testAuth(sendOnly, { tables: authTables });
    try {
      await signUp(auth);
      const hijacked = await actingAs(auth, { email: 'ada@notes.test' });

      await expect(
        post(auth, '/request-password-reset', { email: 'ada@notes.test', redirectTo: '/reset' }),
      ).resolves.toHaveProperty('status', 200);
      expect(mail.sentWith(resetPassword)).toHaveLength(1);
      const token = lastLink(mail, resetPassword, 'ada@notes.test').pathname.split('/').at(-1);

      await expect(post(auth, '/reset-password', { token, newPassword: NEW_PASSWORD })).resolves.toHaveProperty(
        'status',
        200,
      );
      expect(await auth.principal(hijacked.headers)).toBeNull();
      await expect(signIn(auth)).resolves.toHaveProperty('status', 401);
      await expect(signIn(auth, NEW_PASSWORD)).resolves.toHaveProperty('status', 200);
      expect(mail.sentWith(resetPassword)).toHaveLength(1);
    } finally {
      await dispose();
    }
  });

  it('a change needs the current password and ends the other sessions', async () => {
    const { auth, dispose } = await testAuth(sendOnly, { tables: authTables });
    try {
      const cookie = cookiesOf(await signUp(auth));
      const other = await actingAs(auth, { email: 'ada@notes.test' });

      const wrong = await post(
        auth,
        '/change-password',
        { currentPassword: 'not my password', newPassword: NEW_PASSWORD },
        { cookie },
      );
      expect(wrong.status).toBeGreaterThanOrEqual(400);
      expect(await auth.principal(other.headers)).not.toBeNull();

      const changed = await post(
        auth,
        '/change-password',
        { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
        { cookie },
      );
      expect(changed.status).toBe(200);
      expect(await auth.principal(other.headers)).toBeNull();
      await expect(signIn(auth, NEW_PASSWORD)).resolves.toHaveProperty('status', 200);
    } finally {
      await dispose();
    }
  });
});
