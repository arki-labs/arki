/**
 * `@arki/auth/testing` — a real auth on an in-memory PGlite (or libSQL), with every mail kept in a
 * sink.
 *
 * `testAuth` builds the same engine as production (same factory, same plugins), so a flow that
 * passes here passes for real. `actingAs` makes a real session through the engine. Import this
 * module only from tests: `@electric-sql/pglite`, `@libsql/client` and `drizzle-kit` are optional
 * peers. `database: 'libsql'` runs the same auth on SQLite, with tables from `@arki/auth/sqlite`.
 *
 * @example
 * const { auth, mail, dispose } = await testAuth(authDefinition, { tables: authTables });
 * const { headers } = await actingAs(auth, { email: 'alice@notes.test', plan: 'pro' });
 * expect((await auth.principal(headers))?.user.plan).toBe('pro');
 * await dispose();
 */
import { PGlite } from '@electric-sql/pglite';
import { pushSchema } from 'drizzle-kit/api-postgres';
import { defineRelations, is, sql } from 'drizzle-orm';
import { getTableConfig, pgSchema, PgTable } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';

import type { MailTemplate } from '@arki/mail';
import type { MailSink } from '@arki/mail/testing';
import { mailer } from '@arki/mail';
import { magicLink } from '@arki/mail/templates/auth';
import { mailSink } from '@arki/mail/testing';

import type { AuthDefinition } from '../definition.js';
import type { Auth, CheckedRuntime } from '../pg/build.js';
import type {
  AuthBindings,
  AuthTables,
  AuthTestingApi,
  SessionValues,
  TablesExposing,
  TestSignInOptions,
  TestUserInput,
} from '../pg/types.js';
import { SOCIAL_METHODS } from '../definition.js';
import { buildAuth } from '../pg/build.js';

/** A secret long enough for production checks; only ever used in tests. */
export const TEST_AUTH_SECRET = 'arki-auth-test-secret-0123456789abcdef';

/** Opens an in-memory PGlite and pushes the tables into it. */
async function openPglite(tables: Readonly<Record<string, unknown>>) {
  const client = new PGlite('memory://');
  await client.waitReady;
  const db = drizzle({ client });
  // The push only creates the Postgres schemas it is given; add the ones the tables live in.
  const schemaNames = Object.values(tables).flatMap(value =>
    is(value, PgTable) ? [getTableConfig(value).schema ?? 'public'] : [],
  );
  const schemas = Object.fromEntries(
    [...new Set(schemaNames)].filter(name => name !== 'public').map(name => [`schema:${name}`, pgSchema(name)]),
  );
  const { apply } = await pushSchema({ ...schemas, ...tables }, db);
  await apply();
  return { db, close: () => client.close() };
}

/** Opens an in-memory libSQL database and creates the tables in it. */
async function openLibsql(tables: Readonly<Record<string, unknown>>) {
  // Loaded here, so an app testing on PGlite needs neither `@libsql/client` nor the SQLite kit.
  const { createLibsqlDb } = await import('@arki/db/libsql');
  const { generateDrizzleJson, generateMigration } = await import('drizzle-kit/payload/sqlite');
  const { db, close } = createLibsqlDb({ url: ':memory:', relations: defineRelations({}) });
  // drizzle-kit has no SQLite push that takes a Drizzle database: diff from empty and run the DDL.
  const statements = await generateMigration(await generateDrizzleJson({}), await generateDrizzleJson({ ...tables }));
  for (const statement of statements) await db.run(sql.raw(statement));
  return { db, close: () => Promise.resolve(close()) };
}

const openers = { pglite: openPglite, libsql: openLibsql };

/** The in-memory databases `testAuth` runs on. */
export type TestDatabase = keyof typeof openers;

/** The Drizzle database `testAuth` hands back for `database`. */
export type TestDb<B extends TestDatabase> = Awaited<ReturnType<(typeof openers)[B]>>['db'];

export type TestAuthBindings<
  D extends AuthDefinition,
  T extends AuthTables,
  S extends SessionValues<T> = SessionValues<T>,
> = Partial<Omit<AuthBindings<D, T, S>, 'db' | 'tables' | 'runtime'>> & {
  /** The tables, built for the database: `@arki/auth/pg` for PGlite, `@arki/auth/sqlite` for libSQL. */
  readonly tables: T & TablesExposing<D>;
  /** Other tables to create next to the auth tables (an app's tables that point at users). */
  readonly schema?: Readonly<Record<string, unknown>>;
  /** Overrides of the test runtime. Every enabled social provider gets fake credentials. */
  readonly runtime?: Partial<Omit<CheckedRuntime, 'providers'>>;
};

export type TestAuth<D extends AuthDefinition, T extends AuthTables, B extends TestDatabase = 'pglite'> = {
  readonly auth: Auth<D, T>;
  readonly db: TestDb<B>;
  /** Every mail the auth sent. */
  readonly mail: MailSink;
  /** The same database again: a second auth (another secret, another replica) over the same rows. */
  readonly rebuild: (bindings?: Omit<TestAuthBindings<D, T>, 'tables' | 'schema'>) => Auth<D, T>;
  readonly dispose: () => Promise<void>;
};

const fakeProviders = Object.fromEntries(
  SOCIAL_METHODS.map(method => [method, { clientId: `${method}-test-id`, clientSecret: `${method}-test-secret` }]),
);

/**
 * A real auth on a fresh in-memory database with the auth tables created: PGlite by default,
 * libSQL with `database: 'libsql'`. Mail goes to a sink; rate limiting is off unless `rateLimit`
 * is given; the runtime is local and not production.
 */
export async function testAuth<
  D extends AuthDefinition,
  T extends AuthTables,
  S extends SessionValues<T> = SessionValues<T>,
>(
  definition: D,
  bindings: TestAuthBindings<D, T, S> & { readonly database: 'libsql' },
): Promise<TestAuth<D, T, 'libsql'>>;
// Last, so `ReturnType<typeof testAuth>` keeps meaning the default PGlite auth.
export async function testAuth<
  D extends AuthDefinition,
  T extends AuthTables,
  S extends SessionValues<T> = SessionValues<T>,
>(definition: D, bindings: TestAuthBindings<D, T, S> & { readonly database?: 'pglite' }): Promise<TestAuth<D, T>>;
export async function testAuth<
  D extends AuthDefinition,
  T extends AuthTables,
  S extends SessionValues<T> = SessionValues<T>,
>(
  definition: D,
  bindings: TestAuthBindings<D, T, S> & { readonly database?: TestDatabase },
): Promise<TestAuth<D, T, TestDatabase>> {
  const { database = 'pglite', ...rest } = bindings;
  const { db, close } = await openers[database]({ ...rest.schema, ...rest.tables });

  const sink = mailSink();
  const sinkMailer = mailer({ transport: sink, from: `${definition.app.name} <auth@test.dev>` });
  const build = (overrides: Omit<TestAuthBindings<D, T>, 'tables' | 'schema'> = {}) => {
    const { runtime, ...others } = { ...rest, ...overrides };
    return buildAuth(definition, {
      rateLimit: false,
      mail: sinkMailer,
      ...others,
      db,
      runtime: () => ({
        url: 'http://localhost:3000',
        secret: TEST_AUTH_SECRET,
        production: false,
        providers: fakeProviders,
        ...runtime,
      }),
    });
  };

  return {
    auth: build(),
    db,
    mail: sink,
    rebuild: build,
    dispose: close,
  };
}

/**
 * Signs a user in through the engine: finds or creates the user (verified), creates a real
 * session, and returns headers that carry it. `password` also sets the user's password. The session is listable and revocable like any
 * other. Throws `ARKI_AUTH_E005` when the auth runs in production.
 */
export function actingAs<U>(
  auth: { readonly testing: AuthTestingApi<U> },
  user: TestUserInput<U>,
  options?: TestSignInOptions,
): Promise<{ readonly headers: Headers; readonly user: U }> {
  return auth.testing.signIn(user, options);
}

/** The link in the latest mail from `template` to `to`. Throws when there is none. */
export function lastLink(mail: MailSink, template: Pick<MailTemplate, 'name'>, to: string): URL {
  const sent = mail.sentTo(to).filter(record => record.template === template.name);
  const text = sent.at(-1)?.message.text;
  const url = text === undefined ? undefined : /https?:\/\/\S+/.exec(text)?.[0];
  if (url === undefined) throw new Error(`No "${template.name}" mail with a link was sent to ${to}.`);
  return new URL(url);
}

/** The link in the latest magic-link mail to `to`. */
export const lastMagicLink = (mail: MailSink, to: string): URL => lastLink(mail, magicLink, to);
