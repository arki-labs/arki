/**
 * Account self-service (`account` in the definition) through the real engine: each switch is off
 * by default and its routes are absent (404), so an app never exposes a flow it did not choose.
 * When on, change email proves the new address by mail first, and delete leaves no user and no
 * session behind.
 */
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { describe, expect, it } from 'vitest';

import { verifyEmail } from '@arki/mail/templates/auth';

import { get, PASSWORD, post } from '../../__fixtures__/http.js';
import { authTables } from '../../__fixtures__/tables.js';
import { defineAuth } from '../../definition.js';
import { AUTH_ERROR_CODES } from '../../errors.js';
import { actingAs, lastLink, testAuth } from '../../testing/index.js';
import { createAuth } from '../index.js';

const closed = defineAuth({ app: { name: 'Notes', key: 'notes' }, methods: ['password', 'google'] });
const open = defineAuth({
  app: { name: 'Notes', key: 'notes' },
  methods: ['password', 'google'],
  // Like an app whose sign-up asks for no verify link: change email must still verify the new address.
  verifyEmail: 'none',
  account: { changeEmail: true, linking: true, delete: true },
});

describe('account switches', () => {
  it('map to the engine options, all off by default', async () => {
    const off = await testAuth(closed, { tables: authTables });
    const on = await testAuth(open, { tables: authTables });
    try {
      // The engine's own default for linking is on; off must be said explicitly.
      expect(off.auth.engine.options.user).toMatchObject({
        changeEmail: { enabled: false },
        deleteUser: { enabled: false },
      });
      expect(off.auth.engine.options.account).toMatchObject({ accountLinking: { enabled: false } });
      expect(on.auth.engine.options.user).toMatchObject({
        changeEmail: { enabled: true },
        deleteUser: { enabled: true },
      });
      expect(on.auth.engine.options.account).toMatchObject({ accountLinking: { enabled: true } });
    } finally {
      await off.dispose();
      await on.dispose();
    }
  });

  it('answer 404 on every account route while off, even for a signed-in user', async () => {
    const { auth, db, dispose } = await testAuth(closed, { tables: authTables });
    try {
      const { headers, user } = await actingAs(auth, { email: 'ada@notes.test' });
      const cookie = { cookie: headers.get('cookie') ?? '' };
      await expect(post(auth, '/change-email', { newEmail: 'new@notes.test' }, cookie)).resolves.toHaveProperty(
        'status',
        404,
      );
      await expect(post(auth, '/link-social', { provider: 'google' }, cookie)).resolves.toHaveProperty('status', 404);
      await expect(post(auth, '/delete-user', {}, cookie)).resolves.toHaveProperty('status', 404);
      await expect(get(auth, '/delete-user/callback?token=x', cookie)).resolves.toHaveProperty('status', 404);
      // Nothing happened behind the 404.
      expect(await db.select().from(authTables.User).where(eq(authTables.User.id, user.id))).toHaveLength(1);
    } finally {
      await dispose();
    }
  });

  it('refuses `changeEmail` without a mailer at boot (E003): the flow cannot work without mail', () => {
    const client = new PGlite('memory://');
    const socialOnly = defineAuth({
      app: { name: 'Notes', key: 'notes' },
      methods: ['google'],
      account: { changeEmail: true },
    });
    const build = () =>
      createAuth(socialOnly, {
        db: drizzle({ client }),
        tables: authTables,
        runtime: () => ({
          url: 'http://localhost:3000',
          secret: undefined,
          production: false,
          providers: { google: { clientId: 'id', clientSecret: 'secret' } },
        }),
      });
    expect(build).toThrow(expect.objectContaining({ code: AUTH_ERROR_CODES.mailRequired }));
    return client.close();
  });
});

describe('change email', () => {
  it('mails a verify link to the new address and changes the address only when it is used', async () => {
    const { auth, mail, dispose } = await testAuth(open, { tables: authTables });
    try {
      const { headers } = await actingAs(auth, { email: 'ada@notes.test' });
      const cookie = { cookie: headers.get('cookie') ?? '' };
      await expect(post(auth, '/change-email', { newEmail: 'ada@new.test' }, cookie)).resolves.toHaveProperty(
        'status',
        200,
      );
      expect(mail.sentWith(verifyEmail)).toHaveLength(1);
      expect(mail.sentTo('ada@new.test')).toHaveLength(1);
      // Not changed yet: whoever holds the session has not proven they own the new address.
      await expect(auth.principal(headers)).resolves.toMatchObject({ user: { email: 'ada@notes.test' } });

      const used = await get(auth, lastLink(mail, verifyEmail, 'ada@new.test'), cookie);
      expect(used.status).toBeLessThan(400);
      await expect(auth.principal(headers)).resolves.toMatchObject({ user: { email: 'ada@new.test' } });
    } finally {
      await dispose();
    }
  });

  it('does not start mailing verify links at sign-up when the definition asks for none', async () => {
    const { auth, mail, dispose } = await testAuth(open, { tables: authTables });
    try {
      const created = await post(auth, '/sign-up/email', { email: 'bo@notes.test', password: PASSWORD, name: 'Bo' });
      expect(created.status).toBe(200);
      expect(mail.sentWith(verifyEmail)).toHaveLength(0);
    } finally {
      await dispose();
    }
  });
});

describe('delete account', () => {
  it('removes the user and every one of their sessions', async () => {
    const { auth, db, dispose } = await testAuth(open, { tables: authTables });
    try {
      const first = await actingAs(auth, { email: 'ada@notes.test' });
      const second = await actingAs(auth, { email: 'ada@notes.test' });
      const deleted = await post(auth, '/delete-user', {}, { cookie: first.headers.get('cookie') ?? '' });
      expect(deleted.status).toBe(200);

      expect(await auth.principal(first.headers)).toBeNull();
      // The other device is signed out too: a deleted account keeps no live session.
      expect(await auth.principal(second.headers)).toBeNull();
      expect(await db.select().from(authTables.User).where(eq(authTables.User.id, first.user.id))).toEqual([]);
      expect(await db.select().from(authTables.Session).where(eq(authTables.Session.userId, first.user.id))).toEqual(
        [],
      );
    } finally {
      await dispose();
    }
  });
});

describe('account linking', () => {
  it('lets a signed-in user start linking a social account when on', async () => {
    const { auth, dispose } = await testAuth(open, { tables: authTables });
    try {
      const { headers } = await actingAs(auth, { email: 'ada@notes.test' });
      const started = await post(
        auth,
        '/link-social',
        { provider: 'google', callbackURL: '/settings' },
        { cookie: headers.get('cookie') ?? '' },
      );
      expect(started.status).toBe(200);
      const body: unknown = await started.json();
      expect(body).toMatchObject({ url: expect.stringContaining('accounts.google.com'), redirect: true });
    } finally {
      await dispose();
    }
  });
});
