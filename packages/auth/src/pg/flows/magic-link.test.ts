/**
 * Review checks 10 and 11 as code: a magic link is stored only as a hash, works once, and dies
 * when it expires. With sign-up off, a stranger's link is refused at verify, not at send, so the
 * send answer never tells who is a member.
 */
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { cookiesOf, get, post } from '../../__fixtures__/http.js';
import { authTables } from '../../__fixtures__/tables.js';
import { defineAuth } from '../../definition.js';
import { lastMagicLink, testAuth } from '../../testing/index.js';

const definition = defineAuth({ app: { name: 'Notes', key: 'notes' }, methods: ['magicLink'] });
const signInOnly = defineAuth({
  app: { name: 'Notes', key: 'notes' },
  methods: ['magicLink'],
  magicLink: { signUp: false },
});

const tokenOf = (link: URL): string => link.searchParams.get('token') ?? '';
const signedIn = (response: Response) =>
  response.headers.getSetCookie().some(line => /session_token=[^;]+/.test(line) && !/max-age=0/i.test(line));

describe('magic link', () => {
  it('is stored hashed, never as the token in the mail', async () => {
    const { auth, db, mail, dispose } = await testAuth(definition, { tables: authTables });
    try {
      await post(auth, '/sign-in/magic-link', { email: 'ada@notes.test' });
      const token = tokenOf(lastMagicLink(mail, 'ada@notes.test'));
      expect(token).not.toBe('');
      const rows = await db.select().from(authTables.Verification);
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain(token);
    } finally {
      await dispose();
    }
  });

  it('signs in once; the same link fails the second time', async () => {
    const { auth, mail, dispose } = await testAuth(definition, { tables: authTables });
    try {
      await post(auth, '/sign-in/magic-link', { email: 'ada@notes.test' });
      const link = lastMagicLink(mail, 'ada@notes.test');
      const first = await get(auth, link);
      expect(signedIn(first)).toBe(true);
      expect(await auth.principal(new Headers({ cookie: cookiesOf(first) }))).not.toBeNull();
      const second = await get(auth, link);
      expect(signedIn(second)).toBe(false);
    } finally {
      await dispose();
    }
  });

  it('fails once it has expired', async () => {
    const { auth, db, mail, dispose } = await testAuth(definition, { tables: authTables });
    try {
      await post(auth, '/sign-in/magic-link', { email: 'ada@notes.test' });
      const link = lastMagicLink(mail, 'ada@notes.test');
      const [row] = await db.select().from(authTables.Verification);
      if (row === undefined) throw new Error('expected a verification row');
      await db
        .update(authTables.Verification)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(authTables.Verification.id, row.id));
      expect(signedIn(await get(auth, link))).toBe(false);
    } finally {
      await dispose();
    }
  });

  it('with sign-up off, sends to a stranger but refuses at verify and creates no user', async () => {
    const { auth, db, mail, dispose } = await testAuth(signInOnly, { tables: authTables });
    try {
      const sent = await post(auth, '/sign-in/magic-link', { email: 'stranger@notes.test' });
      expect(sent.status).toBe(200);
      expect(mail.sentTo('stranger@notes.test')).toHaveLength(1);
      expect(signedIn(await get(auth, lastMagicLink(mail, 'stranger@notes.test')))).toBe(false);
      expect(await db.select().from(authTables.User)).toHaveLength(0);
    } finally {
      await dispose();
    }
  });
});
