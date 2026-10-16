/**
 * Two tenants on one scoped table, end to end on real Postgres 16 and 18
 * (testcontainers): Drizzle declaration, generated triggers, `pgSource`, the
 * hub and the HTTP endpoint behind a real server (scoped-hints plan § 2.7).
 *
 * Why this test exists: every other scoped test feeds the hub by hand or
 * reads NOTIFY payloads directly. Only here does a tenant's write travel the
 * whole way a production write does, so this is where "tenant B's client
 * never sees tenant A's key or receipt, and gets no frame for A's writes" is
 * proven for the shipped pieces together, on separate connections.
 */
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { oc } from '@orpc/contract';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { pgTable, text, uuid } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { ListenHandle } from '@arki/http';
import { listen } from '@arki/http';

import type { LiveEvent, LiveHub, LiveMeta } from '../index.js';
import type { SseReader } from './sse-reader.js';
import { live, liveScopes, tableTag } from '../drizzle/index.js';
import { liveEndpoint } from '../http.js';
import { createLiveHub, liveTables } from '../index.js';
import { liveManifest } from '../orpc/index.js';
import { liveMigration, pgSource } from '../pg/index.js';
import { RECEIPTS } from './fixtures.js';
import { sseReader } from './sse-reader.js';

const posts = pgTable('posts', {
  id: text('id').primaryKey(),
  orgId: uuid('org_id').notNull(),
  title: text('title').notNull(),
});
const scopes = liveScopes({ org: [[posts, posts.orgId]] });
const base = oc.$meta<LiveMeta>({});
const manifest = liveManifest(
  {
    posts: {
      list: base
        .meta(live({ reads: [posts], scope: { org: 'input.orgId' } }))
        .input(z.object({ orgId: z.uuid() }))
        .output(z.array(z.string())),
    },
  },
  { scopes },
);
const POSTS = tableTag(posts);
const A = '0a000000-0000-4000-8000-000000000000';
const B = '0b000000-0000-4000-8000-000000000000';

/** Change frames until their receipts cover `receipts`. */
async function framesUntil(reader: SseReader, receipts: readonly string[]): Promise<LiveEvent[]> {
  const missing = new Set(receipts);
  const frames: LiveEvent[] = [];
  while (missing.size > 0) {
    const frame = await reader.next();
    if (frame === undefined) throw new Error('the stream ended');
    frames.push(frame);
    if (frame.kind === 'change') for (const receipt of frame.txids) missing.delete(receipt);
  }
  return frames;
}

describe.each(['postgres:16-alpine', 'postgres:18-alpine'])('two tenants on %s', image => {
  let container: StartedPostgreSqlContainer;
  let writer: pg.Pool;
  let listenPool: pg.Pool;
  let hub: LiveHub;
  let server: ListenHandle;
  let url: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(image).start();
    writer = new pg.Pool({ connectionString: container.getConnectionUri(), max: 2 });
    listenPool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 1 });
    listenPool.on('error', () => null);
    await writer.query('create table posts (id text primary key, org_id uuid not null, title text not null)');
    await writer.query(liveMigration({ app: 'blog', tables: liveTables(manifest), scopes }).up);
    hub = createLiveHub({
      source: pgSource({ pool: listenPool, app: 'blog' }),
      limits: { batchMs: 5 },
      receipts: RECEIPTS,
    });
    // Resolves once the listener is up: the hub is ready.
    await hub.start();
    const endpoint = liveEndpoint({
      hub,
      manifest,
      scopes,
      // The tenant comes from a header here; a real app reads the session's memberships.
      authorize: request => {
        const org = request.headers.get('x-org');
        return Promise.resolve(org === null ? null : { scopes: { org: [org] } });
      },
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

  async function connect(org: string): Promise<SseReader> {
    const response = await fetch(url, { headers: { 'x-org': org } });
    expect(response.status).toBe(200);
    return sseReader(response);
  }

  /** One transaction inserting a post per org; its receipt. */
  async function write(id: string, ...orgs: readonly string[]): Promise<string> {
    const values = orgs.map((_, index) => `($${index * 2 + 1}, $${index * 2 + 2}, 'x')`).join(', ');
    const inserted = await writer.query<{ txid: string }>(
      `with rows as (insert into posts values ${values} returning 1) select pg_current_xact_id()::text as txid from rows limit 1`,
      orgs.flatMap((org, index) => [`${id}-${index}`, org]),
    );
    return RECEIPTS.of(inserted.rows[0]?.txid ?? '');
  }

  it('B gets no frame, key or receipt of A’s writes; a transaction writing both shows each its own key', async () => {
    const a = await connect(A);
    const b = await connect(B);
    expect(await a.next()).toMatchObject({ kind: 'hello', scopes: { org: [A] } });
    expect(await b.next()).toMatchObject({ kind: 'hello', manifest, scopes: { org: [B] } });

    const receiptsOfA: string[] = [];
    for (let index = 0; index < 20; index += 1) receiptsOfA.push(await write(`a${index}`, A));
    const seenByA = await framesUntil(a, receiptsOfA);
    for (const frame of seenByA)
      expect(frame).toMatchObject({ tags: [{ ...POSTS, scope: { name: 'org', keys: [A] } }] });

    // A's twenty commits are all through the hub; B's next frame is its own write.
    const ofB = await write('b0', B);
    const [first, ...rest] = await framesUntil(b, [ofB]);
    expect(rest).toEqual([]);
    expect(first).toEqual({
      kind: 'change',
      cursor: expect.stringMatching(/^[\w-]{75}$/),
      tags: [{ ...POSTS, scope: { name: 'org', keys: [B] } }],
      txids: [ofB],
    });

    // One transaction for both orgs: each sees only its own key. The shared receipt is the documented residual.
    const both = await write('ab', A, B);
    expect(await framesUntil(b, [both])).toEqual([
      expect.objectContaining({ tags: [{ ...POSTS, scope: { name: 'org', keys: [B] } }], txids: [both] }),
    ]);
    const lastOfA = await framesUntil(a, [both]);
    expect(lastOfA.at(-1)).toMatchObject({ tags: [{ ...POSTS, scope: { name: 'org', keys: [A] } }], txids: [both] });
    await Promise.all([a.cancel(), b.cancel()]);
  });
});
