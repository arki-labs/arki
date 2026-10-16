/**
 * `@arki/auth/testing` — a real auth on an in-memory PGlite, with every mail kept in a sink.
 *
 * `testAuth` builds the same engine as production (same factory, same plugins), so a flow that
 * passes here passes for real. `actingAs` makes a real session through the engine. Import this
 * module only from tests: `@electric-sql/pglite` and `drizzle-kit` are optional peers.
 *
 * @example
 * const { auth, mail, dispose } = await testAuth(authDefinition, { tables: authTables });
 * const { headers } = await actingAs(auth, { email: 'alice@notes.test', plan: 'pro' });
 * expect((await auth.principal(headers))?.user.plan).toBe('pro');
 * await dispose();
 */
import { PGlite } from '@electric-sql/pglite';
import { pushSchema } from 'drizzle-kit/api-postgres';
import { is } from 'drizzle-orm';
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
  AuthDb,
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

export type TestAuthBindings<
  D extends AuthDefinition,
  T extends AuthTables,
  S extends SessionValues<T> = SessionValues<T>,
> = Partial<Omit<AuthBindings<D, T, S>, 'db' | 'tables' | 'runtime'>> & {
  readonly tables: T & TablesExposing<D>;
  /** Other tables to create next to the auth tables (an app's tables that point at users). */
  readonly schema?: Readonly<Record<string, unknown>>;
  /** Overrides of the test runtime. Every enabled social provider gets fake credentials. */
  readonly runtime?: Partial<Omit<CheckedRuntime, 'providers'>>;
};

export type TestAuth<D extends AuthDefinition, T extends AuthTables> = {
  readonly auth: Auth<D, T>;
  readonly db: AuthDb;
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
 * A real auth on a fresh in-memory database with the auth tables pushed. Mail goes to a sink;
 * rate limiting is off unless `rateLimit` is given; the runtime is local and not production.
 */
export async function testAuth<
  D extends AuthDefinition,
  T extends AuthTables,
  S extends SessionValues<T> = SessionValues<T>,
>(definition: D, bindings: TestAuthBindings<D, T, S>): Promise<TestAuth<D, T>> {
  const client = new PGlite('memory://');
  await client.waitReady;
  const db = drizzle({ client });
  const tables: Record<string, unknown> = { ...bindings.schema, ...bindings.tables };
  // The push only creates the Postgres schemas it is given; add the ones the tables live in.
  const schemaNames = Object.values(tables).flatMap(value =>
    is(value, PgTable) ? [getTableConfig(value).schema ?? 'public'] : [],
  );
  const schemas = Object.fromEntries(
    [...new Set(schemaNames)].filter(name => name !== 'public').map(name => [`schema:${name}`, pgSchema(name)]),
  );
  const imports = { ...schemas, ...tables };
  const { apply } = await pushSchema(imports, db);
  await apply();

  const sink = mailSink();
  const sinkMailer = mailer({ transport: sink, from: `${definition.app.name} <auth@test.dev>` });
  const build = (overrides: Omit<TestAuthBindings<D, T>, 'tables' | 'schema'> = {}) => {
    const { runtime, ...rest } = { ...bindings, ...overrides };
    return buildAuth(definition, {
      rateLimit: false,
      mail: sinkMailer,
      ...rest,
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
    dispose: () => client.close(),
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
