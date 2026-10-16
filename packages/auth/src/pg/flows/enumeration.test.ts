/**
 * No account enumeration: sign-in, recovery and registration answer the same for an email that
 * exists and one that does not, so an attacker cannot build a list of members.
 */
import { describe, expect, it } from 'vitest';

import { PASSWORD, post } from '../../__fixtures__/http.js';
import { authTables } from '../../__fixtures__/tables.js';
import { defineAuth } from '../../definition.js';
import { testAuth } from '../../testing/index.js';

const definition = defineAuth({ app: { name: 'Notes', key: 'notes' }, methods: ['password', 'magicLink'] });

async function answer(response: Response) {
  const body: unknown = await response.json();
  return { status: response.status, body };
}

describe('no enumeration', () => {
  it('unknown email and wrong password give the same status and body', async () => {
    const { auth, dispose } = await testAuth(definition, { tables: authTables });
    try {
      await post(auth, '/sign-up/email', { email: 'ada@notes.test', password: PASSWORD, name: 'Ada' });
      const wrongPassword = await answer(
        await post(auth, '/sign-in/email', { email: 'ada@notes.test', password: 'nope nope nope' }),
      );
      const unknownEmail = await answer(
        await post(auth, '/sign-in/email', { email: 'nobody@notes.test', password: 'nope nope nope' }),
      );
      expect(unknownEmail).toEqual(wrongPassword);
      expect(unknownEmail.status).toBe(401);
    } finally {
      await dispose();
    }
  });

  it('a reset request for an unknown email answers 200 and sends nothing', async () => {
    const { auth, mail, dispose } = await testAuth(definition, { tables: authTables });
    try {
      const response = await post(auth, '/request-password-reset', {
        email: 'nobody@notes.test',
        redirectTo: '/reset',
      });
      expect(response.status).toBe(200);
      expect(mail.sent).toHaveLength(0);
    } finally {
      await dispose();
    }
  });

  it('a magic-link request answers the same for a known and an unknown email', async () => {
    const { auth, dispose } = await testAuth(definition, { tables: authTables });
    try {
      await post(auth, '/sign-up/email', { email: 'ada@notes.test', password: PASSWORD, name: 'Ada' });
      const known = await answer(await post(auth, '/sign-in/magic-link', { email: 'ada@notes.test' }));
      const unknown = await answer(await post(auth, '/sign-in/magic-link', { email: 'nobody@notes.test' }));
      expect(unknown).toEqual(known);
    } finally {
      await dispose();
    }
  });

  it('a sign-up for an existing email answers like a new one when verification is on', async () => {
    const { auth, dispose } = await testAuth(definition, { tables: authTables });
    try {
      const fresh = await post(auth, '/sign-up/email', { email: 'ada@notes.test', password: PASSWORD, name: 'Ada' });
      const again = await post(auth, '/sign-up/email', { email: 'ada@notes.test', password: PASSWORD, name: 'Ada' });
      expect(again.status).toBe(fresh.status);
      const freshBody: unknown = await fresh.json();
      const againBody: unknown = await again.json();
      expect(new Set(Object.keys(new Object(againBody)))).toEqual(new Set(Object.keys(new Object(freshBody))));
    } finally {
      await dispose();
    }
  });
});
