/**
 * The server half of the fixture app: one hub per process, listening on its
 * own pool of one connection, the live endpoint, and the oRPC router. Started
 * on the first request (the e2e readiness probe), so a restarted process is a
 * new hub with a new epoch.
 */
import { randomUUID } from 'node:crypto';
import { implement, ORPCError } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';
import pg from 'pg';

import { createLiveHub } from '@arki/live';
import { liveEndpoint } from '@arki/live/http';
import { pgSource } from '@arki/live/pg';

import { appContract, LIVE_APP_NAME, liveAppManifest } from './contract';

function databaseUrl(): string {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    throw new Error('DATABASE_URL is not set: the e2e global setup starts Postgres and passes its URL to the server.');
  }
  return url;
}

async function startServerApp() {
  const connectionString = databaseUrl();
  const writer = new pg.Pool({ connectionString, max: 4 });
  // `pgSource` holds one connection for LISTEN, apart from the writers.
  const listenPool = new pg.Pool({ connectionString, max: 1, application_name: 'live_e2e_listener' });
  // A dropped listen connection is reported by `pgSource` (as a gap) and retried; the pool's own
  // `error` event must not crash the process.
  listenPool.on('error', () => null);

  const hub = createLiveHub({
    source: pgSource({ pool: listenPool, app: LIVE_APP_NAME, retryMs: 100 }),
    limits: { batchMs: 5 },
  });
  await hub.start();
  const endpoint = liveEndpoint({ hub, manifest: liveAppManifest, authorize: () => Promise.resolve({}) });

  const impl = implement(appContract);
  const router = impl.router({
    posts: {
      list: impl.posts.list.handler(async () => {
        const result = await writer.query<{ id: string; title: string }>(
          'select id, title from posts order by created_at, id',
        );
        return result.rows;
      }),
      create: impl.posts.create.handler(async ({ input }) => {
        const result = await writer.query<{ id: string; txid: string }>(
          `with row as (insert into posts (id, title) values ($1, $2) returning id)
           select id, pg_current_xact_id()::text as txid from row`,
          [randomUUID(), input.title],
        );
        const row = result.rows[0];
        if (row === undefined) throw new ORPCError('INTERNAL_SERVER_ERROR', { message: 'the insert returned no row' });
        return row;
      }),
    },
  });

  return { hub, endpoint, rpc: new RPCHandler(router) };
}

let started: ReturnType<typeof startServerApp> | undefined;

/** The process's hub, endpoint and oRPC handler, started once. */
export function serverApp(): ReturnType<typeof startServerApp> {
  started ??= startServerApp();
  return started;
}
