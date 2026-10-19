/**
 * `liveQueries({ scopes, reauthorize, maxKeys })` in a Dot app on PGlite,
 * served by `http()`.
 *
 * Why these tests exist: in a Dot app the plugin is the only place the scope
 * declaration reaches the boot check, the manifest and the endpoint. If it
 * dropped `reauthorize`, a memberships table without its trigger would boot
 * and a removed membership would keep its stream until `maxAgeMs`; if it
 * dropped `maxKeys`, boot would reject the migration it was generated with;
 * if it dropped `scopes`, a tenant's write would reach no stream (or the
 * manifest would refuse the scoped meta).
 */
import { PGlite } from '@electric-sql/pglite';
import { oc } from '@orpc/contract';
import { implement } from '@orpc/server';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineApp } from '@arki/dot';
import { defineFeature } from '@arki/dot/feature';
import { rpc } from '@arki/dot/orpc';
import { plugin } from '@arki/dot/plugin';
import { orThrow, UnexpectedDefect } from '@arki/failure';
import { http } from '@arki/http/dot';

import type { LiveMeta } from '../index.js';
import type { SseReader } from './sse-reader.js';
import { liveQueries } from '../dot.js';
import { live, liveScopes, tableTag } from '../drizzle/index.js';
import { LIVE_ERROR_CODES, liveTables } from '../index.js';
import { liveManifest } from '../orpc/index.js';
import { liveMigration } from '../pg/index.js';
import { RECEIPTS } from './fixtures.js';
import { pglitePool } from './pglite-pool.js';
import { sseReader } from './sse-reader.js';

const notes = pgTable('notes', { id: text('id').primaryKey(), orgId: text('org_id').notNull() });
const memberships = pgTable('memberships', { userId: text('user_id').notNull(), orgId: text('org_id').notNull() });
const scopes = liveScopes({ org: [[notes, notes.orgId]], user: [[memberships, memberships.userId]] });
/** Not the default (65 536): boot must compare it with the migration's. */
const MAX_KEYS = 1000;

const contract = oc.$meta<LiveMeta>({});
const notesContract = contract.router({
  list: contract
    .meta(live({ reads: [notes], scope: { org: 'input.orgId' } }))
    .input(z.object({ orgId: z.string() }))
    .output(z.array(z.string())),
});
const notesFeature = defineFeature('notes').entrypoints(
  rpc(notesContract, implement(notesContract), { list: o => o.list.handler(() => []) }),
);
const appContract = { notes: notesContract };
const manifest = liveManifest(appContract, { scopes });

/** The team app; `memberships` gets its triggers unless `withoutMemberships`. */
function teamApp(options: { readonly withoutMemberships?: boolean } = {}) {
  const tables = [...liveTables(manifest), ...(options.withoutMemberships === true ? [] : [tableTag(memberships)])];
  const triggers = liveMigration({ app: 'team', tables, scopes, maxKeys: MAX_KEYS }).up;
  const pglite = new PGlite();
  const pool = pglitePool(pglite);
  /** Each user's orgs: what `authorize` reads, as a session would. */
  const orgsOf = new Map<string, string[]>([
    ['u1', ['A']],
    ['u2', ['B']],
  ]);
  const database = plugin({
    name: 'db',
    provides: { db: () => drizzle({ client: pglite }) },
    async dispose() {
      await pglite.close();
    },
  });
  const schema = plugin({
    name: 'schema',
    needs: { db: database.provides.db },
    async boot() {
      await pglite.exec(`
        create table notes (id text primary key, org_id text not null);
        create table memberships (user_id text not null, org_id text not null);
        ${triggers}
      `);
    },
  });
  const liveQ = liveQueries({
    app: 'team',
    needs: { db: database.provides.db },
    db: ({ db: handle }) => handle,
    pool: () => pool,
    contract: appContract,
    scopes,
    reauthorize: [tableTag(memberships)],
    maxKeys: MAX_KEYS,
    authorize: request => {
      const user = request.headers.get('x-user');
      const orgs = user === null ? undefined : orgsOf.get(user);
      return Promise.resolve(user === null || orgs === undefined ? null : { scopes: { org: orgs, user: [user] } });
    },
    limits: { batchMs: 1 },
    receipts: RECEIPTS,
  });
  const app = defineApp('team')
    .use(database)
    .use(schema)
    .use(liveQ)
    .features([notesFeature])
    .serve(http({ port: 0, bundles: [liveQ.provides.liveRoutes] }));
  return { app, orgsOf };
}

describe('liveQueries with scopes', () => {
  it('fails boot with E002 when a reauthorize table has no trigger', async () => {
    const { app } = teamApp({ withoutMemberships: true });
    const failure = await app.boot();
    expect(UnexpectedDefect.is(failure)).toBe(true);
    expect(failure).toMatchObject({
      cause: {
        code: LIVE_ERROR_CODES.triggers,
        message: expect.stringMatching(/public\.memberships \(missing-trigger\)/),
      },
    });
  });

  it('boots with the migration’s maxKeys; a write reaches only its org’s stream; a membership write sends bye', async () => {
    const { app, orgsOf } = teamApp();
    const started = await orThrow(app.start());
    const readers: SseReader[] = [];
    try {
      const url = started.services.httpServer.url();
      if (url === undefined) throw new Error('the server has no url');
      const connect = async (user: string): Promise<SseReader> => {
        const response = await fetch(new URL('/api/live', url), { headers: { 'x-user': user } });
        expect(response.status).toBe(200);
        const reader = sseReader(response);
        readers.push(reader);
        return reader;
      };
      const u1 = await connect('u1');
      const u2 = await connect('u2');
      expect(await u1.next()).toMatchObject({ kind: 'hello', manifest, scopes: { org: ['A'], user: ['u1'] } });
      expect(await u2.next()).toMatchObject({ kind: 'hello', scopes: { org: ['B'], user: ['u2'] } });

      const { db } = started.services;
      await db.insert(notes).values({ id: 'n1', orgId: 'A' });
      expect(await u1.next()).toMatchObject({ tags: [{ ...tableTag(notes), scope: { name: 'org', keys: ['A'] } }] });
      await db.insert(notes).values({ id: 'n2', orgId: 'B' });
      // u2's first frame is B's write: A's never reached it.
      expect(await u2.next()).toMatchObject({ tags: [{ ...tableTag(notes), scope: { name: 'org', keys: ['B'] } }] });

      orgsOf.set('u1', ['B']);
      await db.insert(memberships).values({ userId: 'u1', orgId: 'B' });
      expect(await u1.next()).toEqual({ kind: 'bye' });
    } finally {
      for (const reader of readers) await reader.cancel();
      await orThrow(started.dispose());
    }
  });
});
