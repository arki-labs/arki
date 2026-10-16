/**
 * Server-written user columns stay server-written: a client can set only the columns the
 * definition lists in `signUpFields`, never an exposed-only or a hidden one.
 */
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { PASSWORD, post } from '../../__fixtures__/http.js';
import { authTables } from '../../__fixtures__/tables.js';
import { defineAuth } from '../../definition.js';
import { testAuth } from '../../testing/index.js';

const exposedOnly = defineAuth({
  app: { name: 'Notes', key: 'notes' },
  methods: ['password'],
  verifyEmail: 'none',
  user: { fields: ['plan'] },
});
const settable = defineAuth({
  app: { name: 'Notes', key: 'notes' },
  methods: ['password'],
  verifyEmail: 'none',
  user: { fields: ['plan'], signUpFields: ['plan'] },
});

const rowOf = async (db: Awaited<ReturnType<typeof testAuth>>['db'], email: string) =>
  db
    .select()
    .from(authTables.User)
    .where(eq(authTables.User.email, email))
    .then(rows => rows[0]);

describe('sign-up fields', () => {
  it('a client cannot set an exposed field outside signUpFields, nor a hidden column', async () => {
    const { auth, db, dispose } = await testAuth(exposedOnly, { tables: authTables });
    try {
      const response = await post(auth, '/sign-up/email', {
        email: 'eve@notes.test',
        password: PASSWORD,
        name: 'Eve',
        plan: 'pro',
        stripeCustomerId: 'cus_forged',
      });
      // The engine accepts the sign-up and drops the fields the client may not set.
      expect(response.status).toBe(200);
      const row = await rowOf(db, 'eve@notes.test');
      expect(row?.plan).toBe('free');
      expect(row?.stripeCustomerId).toBeNull();
    } finally {
      await dispose();
    }
  });

  it('a client can set a field listed in signUpFields', async () => {
    const { auth, db, dispose } = await testAuth(settable, { tables: authTables });
    try {
      const response = await post(auth, '/sign-up/email', {
        email: 'ada@notes.test',
        password: PASSWORD,
        name: 'Ada',
        plan: 'pro',
      });
      expect(response.status).toBe(200);
      await expect(rowOf(db, 'ada@notes.test')).resolves.toMatchObject({ plan: 'pro' });
    } finally {
      await dispose();
    }
  });
});
