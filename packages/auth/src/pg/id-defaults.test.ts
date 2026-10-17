/**
 * The engine makes no ids (`generateId: false`), so an auth table whose `id` has no default would
 * insert a null id at the first sign-up, found only in production. Boot refuses it instead.
 */
import { PGlite } from '@electric-sql/pglite';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, describe, expect, it } from 'vitest';

import { mailer } from '@arki/mail';
import { mailSink } from '@arki/mail/testing';

import { allTables, authTables } from '../__fixtures__/tables.js';
import { defineAuth } from '../definition.js';
import { AUTH_ERROR_CODES } from '../errors.js';
import { authSessionColumns } from './schema/index.js';
import { createAuth } from './index.js';

const client = new PGlite('memory://');
const db = drizzle({ client });
afterAll(() => client.close());
const mail = mailer({ transport: mailSink(), from: 'Notes <hi@notes.test>' });
const runtime = () => ({ url: 'http://localhost:3000', secret: undefined, production: false });
const definition = defineAuth({ app: { name: 'Notes', key: 'notes' }, methods: ['password'] });

/** A hand-written session table: `text('id').primaryKey()` has no default. */
const PlainSession = pgTable(
  'sessions',
  authSessionColumns({ id: text('id').primaryKey(), userId: text('user_id').notNull(), fill: 'app' }),
);

const buildWithPlainSession = () =>
  createAuth(definition, { db, tables: { ...authTables, Session: PlainSession }, mail, runtime });

describe('id defaults at boot', () => {
  it('refuses a table whose id has no default (E001), naming the table and the fix', () => {
    expect(buildWithPlainSession).toThrow(expect.objectContaining({ code: AUTH_ERROR_CODES.invalidConfig }));
    expect(buildWithPlainSession).toThrow(/Session.*no default.*createAuthTables.*primaryColumn\(\)/);
  });

  it('accepts the fixture tables, with and without workspaces', () => {
    expect(() => createAuth(definition, { db, tables: authTables, mail, runtime })).not.toThrow();
    const teams = defineAuth({
      app: { name: 'Notes', key: 'notes' },
      methods: ['password'],
      workspaces: { teams: true },
    });
    expect(() => createAuth(teams, { db, tables: allTables, mail, runtime })).not.toThrow();
  });
});
