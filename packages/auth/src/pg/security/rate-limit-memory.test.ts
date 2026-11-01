/**
 * `rateLimit: { store: 'memory' }` is an explicit, logged choice for a single-replica app with no
 * Redis: it still limits brute force on sign-in in production, and the boot log says the budget
 * is per process. Leaving `rateLimit` out in production stays a boot error.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, describe, expect, it } from 'vitest';

import { fakeLog } from '@arki/log/testing';
import { mailer } from '@arki/mail';
import { mailSink } from '@arki/mail/testing';

import { PASSWORD, post } from '../../__fixtures__/http.js';
import { authTables } from '../../__fixtures__/tables.js';
import { defineAuth } from '../../definition.js';
import { AUTH_ERROR_CODES } from '../../errors.js';
import { testAuth } from '../../testing/index.js';
import { createAuth } from '../index.js';

const definition = defineAuth({ app: { name: 'Notes', key: 'notes' }, methods: ['password'], verifyEmail: 'none' });
const production = { production: true, clientIp: { header: 'cf-connecting-ip' } } as const;

const client = new PGlite('memory://');
const db = drizzle({ client });
afterAll(() => client.close());
const mail = mailer({ transport: mailSink(), from: 'Notes <hi@notes.test>' });
const runtime = () => ({
  url: 'http://localhost:3000',
  secret: 'y'.repeat(40),
  production: true,
  clientIp: { header: 'cf-connecting-ip' },
});

const signIn = (auth: { handler: (request: Request) => Promise<Response> }) =>
  post(auth, '/sign-in/email', { email: 'ada@notes.test', password: PASSWORD }, { 'cf-connecting-ip': '203.0.113.7' });

describe("rateLimit: { store: 'memory' }", () => {
  it('limits the 4th sign-in in 10 s in production', async () => {
    const { auth, dispose } = await testAuth(definition, {
      tables: authTables,
      rateLimit: { store: 'memory' },
      runtime: production,
    });
    try {
      const statuses = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        const response = await signIn(auth);
        statuses.push(response.status);
      }
      expect(statuses).not.toContain(429);
      const refused = await signIn(auth);
      expect(refused.status).toBe(429);
      expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    } finally {
      await dispose();
    }
  });

  it('logs a warning at boot naming the app and saying limits are per process', () => {
    using logs = fakeLog();
    createAuth(definition, { db, tables: authTables, mail, rateLimit: { store: 'memory' }, runtime });
    logs.assertLogged({ level: 'warn', category: 'arki:auth', fields: { app: 'Notes' } });
    expect(logs.records.find(record => record.levelName === 'warn')?.message()).toContain('per process');
  });

  it('is still required in production: leaving rateLimit out is E001', () => {
    expect(() => createAuth(definition, { db, tables: authTables, mail, runtime })).toThrow(
      expect.objectContaining({ code: AUTH_ERROR_CODES.invalidConfig }),
    );
  });
});
