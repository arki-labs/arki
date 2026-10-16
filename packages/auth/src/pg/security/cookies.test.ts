/**
 * Review check 1 as code: in production the session cookie cannot be read by scripts, sent over
 * plain HTTP or sent on cross-site subrequests, and it carries the app's prefix.
 */
import { RateLimiterMemory } from 'rate-limiter-flexible';
import { describe, expect, it } from 'vitest';

import { PASSWORD, post } from '../../__fixtures__/http.js';
import { authTables } from '../../__fixtures__/tables.js';
import { defineAuth } from '../../definition.js';
import { testAuth } from '../../testing/index.js';

const definition = defineAuth({ app: { name: 'Notes', key: 'notes' }, methods: ['password'], verifyEmail: 'none' });

describe('session cookie', () => {
  it('is Secure, HttpOnly, SameSite=Lax and prefixed auth-<key> in production', async () => {
    const { auth, dispose } = await testAuth(definition, {
      tables: authTables,
      rateLimit: {
        store: {
          getRateLimiter: (_id, { points = 100, duration = 10 }) => new RateLimiterMemory({ points, duration }),
        },
      },
      runtime: { production: true, url: 'https://notes.test' },
    });
    try {
      const response = await post(
        auth,
        '/sign-up/email',
        { email: 'ada@notes.test', password: PASSWORD, name: 'Ada' },
        { origin: 'https://notes.test' },
      );
      expect(response.status).toBe(200);
      const session = response.headers.getSetCookie().find(line => line.includes('auth-notes.session_token='));
      expect(session).toBeDefined();
      expect(session).toMatch(/^__Secure-auth-notes\.session_token=/);
      expect(session).toMatch(/;\s*Secure/i);
      expect(session).toMatch(/;\s*HttpOnly/i);
      expect(session).toMatch(/;\s*SameSite=Lax/i);
    } finally {
      await dispose();
    }
  });
});
