/**
 * Boot refusals: every deployment mistake fails when the auth is built, with a code, before the
 * engine ever serves a request. And each instance keeps its own secret.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import { afterAll, describe, expect, it } from 'vitest';

import { mailer } from '@arki/mail';
import { mailSink } from '@arki/mail/testing';

import { authTables } from '../__fixtures__/tables.js';
import { defineAuth } from '../definition.js';
import { AUTH_ERROR_CODES } from '../errors.js';
import { actingAs, testAuth } from '../testing/index.js';
import { createAuth } from './index.js';

const client = new PGlite('memory://');
const db = drizzle({ client });
afterAll(() => client.close());

const mail = mailer({ transport: mailSink(), from: 'Notes <hi@notes.test>' });
const local = { url: 'http://localhost:3000', secret: undefined, production: false } as const;
const store = { getRateLimiter: () => new RateLimiterMemory({ points: 100, duration: 10 }) };
const password = defineAuth({ app: { name: 'Notes', key: 'notes' }, methods: ['password'] });

const codeOf = (build: () => unknown): unknown => {
  try {
    build();
  } catch (error) {
    return Reflect.get(new Object(error), 'code');
  }
  return undefined;
};

describe('createAuth refuses at boot', () => {
  it('a 20-character secret in production (E002), before the engine is built', () => {
    expect(
      codeOf(() =>
        createAuth(password, {
          db,
          tables: authTables,
          mail,
          runtime: () => ({ ...local, production: true, secret: 'x'.repeat(20) }),
        }),
      ),
    ).toBe(AUTH_ERROR_CODES.weakSecret);
  });

  it('a missing secret in production (E002)', () => {
    expect(
      codeOf(() =>
        createAuth(password, { db, tables: authTables, mail, runtime: () => ({ ...local, production: true }) }),
      ),
    ).toBe(AUTH_ERROR_CODES.weakSecret);
  });

  it('magicLink without a mailer (E003)', () => {
    const definition = defineAuth({ app: { name: 'Notes', key: 'notes' }, methods: ['magicLink'] });
    expect(codeOf(() => createAuth(definition, { db, tables: authTables, runtime: () => local }))).toBe(
      AUTH_ERROR_CODES.mailRequired,
    );
  });

  it('workspaces without their tables (E007)', () => {
    const definition = defineAuth({
      app: { name: 'Notes', key: 'notes' },
      methods: ['password'],
      workspaces: { teams: true },
    });
    expect(codeOf(() => createAuth(definition, { db, tables: authTables, mail, runtime: () => local }))).toBe(
      AUTH_ERROR_CODES.tableMissing,
    );
  });

  it('an enabled social provider without credentials (E001)', () => {
    const definition = defineAuth({ app: { name: 'Notes', key: 'notes' }, methods: ['google'] });
    expect(
      codeOf(() =>
        createAuth(definition, {
          db,
          tables: authTables,
          runtime: () => ({ ...local, providers: { google: { clientId: '', clientSecret: 'secret' } } }),
        }),
      ),
    ).toBe(AUTH_ERROR_CODES.invalidConfig);
  });

  it('production without a shared rate-limit store, or with it turned off (E001)', () => {
    const production = { ...local, production: true, secret: 'y'.repeat(40) };
    expect(codeOf(() => createAuth(password, { db, tables: authTables, mail, runtime: () => production }))).toBe(
      AUTH_ERROR_CODES.invalidConfig,
    );
    expect(
      codeOf(() => createAuth(password, { db, tables: authTables, mail, rateLimit: false, runtime: () => production })),
    ).toBe(AUTH_ERROR_CODES.invalidConfig);
  });

  it('builds when production has a strong secret, a mailer and a store', () => {
    expect(
      codeOf(() =>
        createAuth(password, {
          db,
          tables: authTables,
          mail,
          rateLimit: { store },
          runtime: () => ({
            ...local,
            production: true,
            secret: 'y'.repeat(40),
            clientIp: { header: 'cf-connecting-ip' },
          }),
        }),
      ),
    ).toBe(undefined);
  });
});

describe('secret isolation', () => {
  it("two instances with different secrets reject each other's cookies", async () => {
    const { auth, rebuild, dispose } = await testAuth(password, { tables: authTables });
    try {
      const other = rebuild({ runtime: { secret: 'another-secret-0123456789abcdef-0123' } });
      const { headers } = await actingAs(auth, { email: 'ada@notes.test' });
      expect(await auth.principal(headers)).not.toBeNull();
      expect(await other.principal(headers)).toBeNull();
    } finally {
      await dispose();
    }
  });
});
