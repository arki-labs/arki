/**
 * Review checks 5 and 23 as code: another site cannot make a signed-in browser act (cookie POST
 * from a foreign origin), and links cannot send a user to an untrusted site after sign-in.
 */
import { describe, expect, it } from 'vitest';

import { post } from '../../__fixtures__/http.js';
import { authTables } from '../../__fixtures__/tables.js';
import { defineAuth } from '../../definition.js';
import { actingAs, testAuth } from '../../testing/index.js';

const definition = defineAuth({ app: { name: 'Notes', key: 'notes' }, methods: ['password', 'magicLink'] });

describe('cross-site requests', () => {
  it('refuses a cookie POST from a foreign origin, and accepts the same request from the app', async () => {
    const { auth, dispose } = await testAuth(definition, { tables: authTables });
    try {
      const { headers } = await actingAs(auth, { email: 'ada@notes.test' });
      const foreign = await post(
        auth,
        '/sign-out',
        {},
        { cookie: headers.get('cookie') ?? '', origin: 'https://evil.example' },
      );
      expect(foreign.status).toBe(403);
      expect(await auth.principal(headers)).not.toBeNull();

      const own = await post(auth, '/sign-out', {}, { cookie: headers.get('cookie') ?? '' });
      expect(own.status).toBe(200);
      expect(await auth.principal(headers)).toBeNull();
    } finally {
      await dispose();
    }
  });

  it('refuses an untrusted callbackURL and sends no mail', async () => {
    const { auth, mail, dispose } = await testAuth(definition, { tables: authTables });
    try {
      const response = await post(auth, '/sign-in/magic-link', {
        email: 'ada@notes.test',
        callbackURL: 'https://evil.example/welcome',
      });
      expect(response.status).toBe(403);
      expect(mail.sent).toHaveLength(0);

      const trusted = await post(auth, '/sign-in/magic-link', { email: 'ada@notes.test', callbackURL: '/welcome' });
      expect(trusted.status).toBe(200);
    } finally {
      await dispose();
    }
  });
});
