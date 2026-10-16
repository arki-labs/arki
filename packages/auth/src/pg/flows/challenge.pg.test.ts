/**
 * Single use under real concurrency, on real Postgres: ten simultaneous redemptions of one magic
 * link make exactly one session. PGlite runs one query at a time, so only a real server can show
 * the race this guards against.
 */
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { pushSchema } from 'drizzle-kit/api-postgres';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgSchema } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { mailer } from '@arki/mail';
import { mailSink } from '@arki/mail/testing';

import { get, post } from '../../__fixtures__/http.js';
import { authTables } from '../../__fixtures__/tables.js';
import { defineAuth } from '../../definition.js';
import { lastMagicLink, TEST_AUTH_SECRET } from '../../testing/index.js';
import { createAuth } from '../index.js';

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 10 });
  const { apply } = await pushSchema({ notes: pgSchema('notes'), ...authTables }, drizzle({ client: pool }));
  await apply();
});

afterAll(async () => {
  await pool.end();
  await container.stop();
});

describe('magic link under concurrency', () => {
  it('ten simultaneous redemptions make exactly one session', async () => {
    const sink = mailSink();
    const auth = createAuth(defineAuth({ app: { name: 'Notes', key: 'notes' }, methods: ['magicLink'] }), {
      db: drizzle({ client: pool }),
      tables: authTables,
      mail: mailer({ transport: sink, from: 'Notes <auth@notes.test>' }),
      rateLimit: false,
      runtime: () => ({ url: 'http://localhost:3000', secret: TEST_AUTH_SECRET, production: false }),
    });
    await post(auth, '/sign-in/magic-link', { email: 'ada@notes.test' });
    const link = lastMagicLink(sink, 'ada@notes.test');

    const responses = await Promise.all(Array.from({ length: 10 }, () => get(auth, link)));
    const sessions = responses.filter(response =>
      response.headers.getSetCookie().some(line => /session_token=[^;]+/.test(line) && !/max-age=0/i.test(line)),
    );
    expect(sessions).toHaveLength(1);
    const { rows } = await pool.query<{ count: string }>('select count(*) from notes.sessions');
    expect(rows[0]?.count).toBe('1');
  });
});
