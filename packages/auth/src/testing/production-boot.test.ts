import type { BetterAuthOptions } from 'better-auth';
import { PGlite } from '@electric-sql/pglite';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/pglite';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import { afterAll, describe, expect, it } from 'vitest';

import { mailer } from '@arki/mail';
import { mailSink } from '@arki/mail/testing';

import { authTables } from '../__fixtures__/tables.js';
import { defineAuth } from '../definition.js';
import { createAuth } from '../pg/index.js';
import { assertAuthBoots } from './production-boot.js';

describe('assertAuthBoots', () => {
  const store = { getRateLimiter: () => new RateLimiterMemory({ points: 100, duration: 10 }) };
  const definition = defineAuth({ app: { name: 'Notes', key: 'notes' }, methods: ['password', 'magicLink', 'google'] });
  const client = new PGlite('memory://');
  const db = drizzle({ client });
  afterAll(() => client.close());

  it('passes for an auth built by createAuth in production', async () => {
    await expect(
      assertAuthBoots(() =>
        Promise.resolve({
          auth: createAuth(definition, {
            db,
            tables: authTables,
            mail: mailer({ transport: mailSink(), from: 'Notes <hi@notes.test>' }),
            rateLimit: { store },
            runtime: () => ({
              url: 'https://notes.test',
              secret: process.env['AUTH_SECRET'],
              production: process.env['NODE_ENV'] === 'production',
              providers: { google: { clientId: 'id', clientSecret: 'secret' } },
              clientIp: { header: 'cf-connecting-ip' },
            }),
          }),
        }),
      ),
    ).resolves.toBeDefined();
  });

  it('fails when the engine silently lacks a declared method (the C1 class)', async () => {
    const options: BetterAuthOptions = {
      database: drizzleAdapter(db, { provider: 'pg', schema: {} }),
      secret: 'z'.repeat(40),
      baseURL: 'https://notes.test',
    };
    const engine = betterAuth(options);
    await expect(assertAuthBoots(() => Promise.resolve({ auth: { definition, engine } }))).rejects.toThrow();
  });
});
