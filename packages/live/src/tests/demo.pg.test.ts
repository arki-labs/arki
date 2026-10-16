/**
 * The M2 demo as a test, on real Postgres 16 and 18 (testcontainers) behind a
 * real HTTP server — what the README's `curl -N` recipe shows by hand:
 *
 *   1. `GET /api/live` answers `hello` (a reset: no cursor yet).
 *   2. A commit from another connection arrives as `change`, with the
 *      transaction's id in `txids`.
 *   3. Killing the listen backend ends the stream with `gap`.
 *   4. Once the listener is back, the old cursor resets: a new epoch.
 *
 * Why this test exists: everything else runs on a fake source or PGlite's
 * single connection. Only here do the listener, the writer and the HTTP
 * stream use separate connections the way production does, so this is where
 * a lost listener is proven to reach the browser as `gap`, not as silence.
 */
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { oc } from '@orpc/contract';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { ListenHandle } from '@arki/http';
import { listen } from '@arki/http';

import type { LiveHub, LiveMeta, TableTag } from '../index.js';
import { liveEndpoint } from '../http.js';
import { createLiveHub, live, liveTables } from '../index.js';
import { liveManifest } from '../orpc/index.js';
import { liveMigration, pgSource } from '../pg/index.js';
import { sseReader } from './sse-reader.js';

const POSTS: TableTag = { schema: 'public', table: 'posts' };
const contract = oc.$meta<LiveMeta>({});
const manifest = liveManifest({ posts: { list: contract.meta(live({ reads: [POSTS] })).output(z.array(z.string())) } });

const LISTENER = 'blog_listener';
const TOKEN = 'demo-token';

describe.each(['postgres:16-alpine', 'postgres:18-alpine'])('demo on %s', image => {
  let container: StartedPostgreSqlContainer;
  let writer: pg.Pool;
  let listenPool: pg.Pool;
  let hub: LiveHub;
  let server: ListenHandle;
  let url: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(image).start();
    writer = new pg.Pool({ connectionString: container.getConnectionUri(), max: 2 });
    // The listener's own pool of one, named so the test can kill its backend.
    listenPool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 1, application_name: LISTENER });
    listenPool.on('error', () => null);
    await writer.query('create table posts (id text primary key, title text not null)');
    await writer.query(liveMigration({ app: 'blog', tables: liveTables(manifest) }).up);

    hub = createLiveHub({ source: pgSource({ pool: listenPool, app: 'blog', retryMs: 50 }), limits: { batchMs: 5 } });
    await hub.start();
    const endpoint = liveEndpoint({
      hub,
      manifest,
      authorize: request => Promise.resolve(request.headers.get('authorization') === `Bearer ${TOKEN}` ? {} : null),
    });
    server = await listen(endpoint.fetch, { port: 0, hostname: '127.0.0.1' });
    url = `http://127.0.0.1:${server.port}/api/live`;
  }, 120_000);

  afterAll(async () => {
    server.forceClose();
    await hub.stop();
    await Promise.all([writer.end(), listenPool.end()]);
    await container.stop();
  });

  const connect = (query = '') => fetch(`${url}${query}`, { headers: { authorization: `Bearer ${TOKEN}` } });

  it('hello, a commit as change with its txid, a killed listener as gap, then a reset', async () => {
    const refused = await fetch(url);
    expect(refused.status).toBe(401);

    const response = await connect();
    expect(response.status).toBe(200);
    const stream = sseReader(response);
    const hello = await stream.next();
    expect(hello).toMatchObject({ kind: 'hello', mode: 'reset', manifest });
    if (hello?.kind !== 'hello') throw new Error('expected hello');

    const inserted = await writer.query<{ txid: string }>(
      `with row as (insert into posts values ('p1', 'Hello') returning 1) select pg_current_xact_id()::text as txid from row`,
    );
    const txid = inserted.rows[0]?.txid;
    expect(await stream.next()).toEqual({
      kind: 'change',
      cursor: expect.stringMatching(/^[\w-]{75}$/),
      tags: [POSTS],
      txids: [txid],
    });

    await writer.query('select pg_terminate_backend(pid) from pg_stat_activity where application_name = $1', [
      LISTENER,
    ]);
    expect(await stream.next()).toEqual({ kind: 'gap' });
    expect(await stream.next()).toBeUndefined();

    // The listener reconnects by itself; until then connects answer 503.
    await expect.poll(() => hub.status(), { timeout: 10_000 }).toBe('ready');
    const again = sseReader(await connect(`?cursor=${hello.cursor}`));
    const reset = await again.next();
    expect(reset).toMatchObject({ kind: 'hello', mode: 'reset' });
    await again.cancel();
  });
});
