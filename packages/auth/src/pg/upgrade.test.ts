/**
 * Existing data survives: a database written before T10 (the four core tables, the old id
 * prefixes, a password hashed by the old setup, a live session) works unchanged with the new
 * factory. Ids now come from the tables, but old ids are just strings to read.
 */
import { makeSignature } from 'better-auth/crypto';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { PASSWORD, post } from '../__fixtures__/http.js';
import { authTables } from '../__fixtures__/tables.js';
import { defineAuth } from '../definition.js';
import { hashPassword } from '../password.js';
import { TEST_AUTH_SECRET, testAuth } from '../testing/index.js';

const definition = defineAuth({
  app: { name: 'Notes', key: 'notes' },
  methods: ['password'],
  user: { fields: ['plan'] },
});

describe('a database made before T10', () => {
  it('signs in an old user with an old password and keeps an old session alive', async () => {
    const { auth, db, dispose } = await testAuth(definition, { tables: authTables });
    try {
      const now = new Date();
      const later = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await db.execute(sql`
        insert into notes.users (id, name, email, email_verified, created_at, updated_at, plan)
                values ('u_legacy1', 'Ada', 'ada@notes.test', true, ${now}, ${now}, 'pro')
      `);
      await db.execute(sql`
        insert into notes.accounts (id, account_id, provider_id, user_id, password, created_at, updated_at)
                values ('acc_legacy1', 'u_legacy1', 'credential', 'u_legacy1', ${await hashPassword(PASSWORD)}, ${now}, ${now})
      `);
      await db.execute(sql`
        insert into notes.sessions (id, expires_at, token, created_at, updated_at, user_id)
                values ('sess_legacy1', ${later}, 'legacytoken123', ${now}, ${now}, 'u_legacy1')
      `);

      const signIn = await post(auth, '/sign-in/email', { email: 'ada@notes.test', password: PASSWORD });
      expect(signIn.status).toBe(200);

      const cookie = `auth-notes.session_token=legacytoken123.${await makeSignature('legacytoken123', TEST_AUTH_SECRET)}`;
      const principal = await auth.principal(new Headers({ cookie }));
      expect(principal?.user).toMatchObject({ id: 'u_legacy1', plan: 'pro' });
      expect(principal?.session.id).toBe('sess_legacy1');
    } finally {
      await dispose();
    }
  });
});
