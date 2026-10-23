// The app pieces the docs examples use but do not define: a Notes app's auth tables,
// its definitions, its env and a real auth on an in-memory database.
import { pgSchema } from 'drizzle-orm/pg-core';

import { defineAuth } from '@arki/auth';
import { authIdSources, createAuthTables } from '@arki/auth/pg';
import { TEST_AUTH_SECRET, testAuth } from '@arki/auth/testing';
import { pgColumns } from '@arki/db/pg';
import { infra } from '@arki/dot/unit';
import { KV } from '@arki/kv';

export const APP_NAME = 'Notes';
export const APP_KEY = 'notes';

const nodeEnv = process.env.NODE_ENV ?? 'development';

export const env = {
  VITE_URL: 'http://localhost:3000',
  PRODUCTION_URL: undefined,
  AUTH_SECRET: TEST_AUTH_SECRET,
  NODE_ENV: nodeEnv,
  GOOGLE_CLIENT_ID: 'google-client-id',
  GOOGLE_CLIENT_SECRET: 'google-client-secret',
  RESEND_API_KEY: 're_docs_fixture_key',
};

export const kv = new KV('redis://localhost:6379', 'notes');

// The four auth tables, with a `plan` user column and an `appContext` session column.
const c = pgColumns(pgSchema('notes'));
export const authTables = createAuthTables(c, {
  fill: 'app',
  ids: authIdSources,
  columns: {
    user: {
      plan: c.text('plan', { enum: ['free', 'pro'] }).notNull().default('free'),
    },
    session: { appContext: c.text('app_context') },
  },
});

export const authDefinition = defineAuth({
  app: { name: APP_NAME, key: APP_KEY },
  methods: ['password', 'magicLink', 'google'],
  user: { fields: ['plan'] },
  sessions: { bearer: true },
});

// Everything `createAuth` needs besides the definition: a database, the tables and the runtime.
const memory = await testAuth(authDefinition, { tables: authTables });
export const bindings = {
  db: memory.db,
  tables: authTables,
  runtime: () => ({
    url: env.VITE_URL,
    secret: env.AUTH_SECRET,
    production: false,
    providers: { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } },
  }),
};
export const db = memory.db;

// The app's database plugin: it publishes the in-memory `db` to the Dot graph.
export const database = infra({
  name: 'database',
  configure: ctx => {
    ctx.registerService('db', 'db');
  },
  provides: { db: () => memory.db },
});

export const appKeyOf = (request: Request | undefined): string => request?.headers.get('x-app-key') ?? APP_KEY;
/** Account ids that got a profile; the app's real `ensureProfile` writes a row. */
export const profiles = new Set<string>();
export const ensureProfile = async (_db: typeof db, profile: { readonly accountId: string }): Promise<void> => {
  profiles.add(profile.accountId);
};

// A native app's auth: Apple sign-in with an id token, bearer sessions, in-memory database.
const nativeDefinition = defineAuth({
  app: { name: APP_NAME, key: APP_KEY },
  methods: ['apple'],
  sessions: { bearer: true },
});
export const { auth } = await testAuth(nativeDefinition, { tables: authTables });

export const page = (parts: { readonly home: string | undefined; readonly action: string }): string =>
  `<a href="${parts.action}">Sign in</a> · <a href="${parts.home ?? ''}">${APP_NAME}</a>`;
