import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { defineRelations, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { defineApp, infra } from '@arki/dot/unit';
import { isFailure, UnexpectedDefect } from '@arki/failure';

import { db, dbMigrations } from './dot.js';
import { createLibsqlDb } from './libsql.js';
import {
  migrateDb,
  MigrationReadFailed,
  MigrationStateFailed,
  MigrationUnconfirmed,
  pendingMigrations,
  readMigrations,
} from './migrate.js';

const directories: string[] = [];
const closes: (() => void)[] = [];
function open() {
  const opened = createLibsqlDb({ url: ':memory:', relations: defineRelations({}) });
  closes.push(opened.close);
  return opened;
}
function absentFolder() {
  const dir = mkdtempSync(path.join(tmpdir(), 'arki-migration-outcomes-'));
  directories.push(dir);
  return path.join(dir, 'absent-private-path');
}
const migration = {
  name: '20260101000000_owned',
  hash: 'fixture',
  folderMillis: 1_767_225_600_000,
  bps: true,
  sql: ['CREATE TABLE owned (value integer);', 'INSERT INTO owned VALUES (1);'],
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const close of closes.splice(0)) close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('migration outcomes', () => {
  it('observes standalone reads, application and inspection without exporting SQL, paths or causes', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    trace.setGlobalTracerProvider(provider);
    try {
      const opened = open();
      expect(MigrationReadFailed.is(readMigrations(absentFolder()))).toBe(true);
      expect(await migrateDb(opened.db, { migrations: [migration] })).toBeUndefined();
      expect(await pendingMigrations(opened.db, { migrations: [migration] })).toEqual([]);
      const spans = exporter.getFinishedSpans();
      expect(spans.map(span => span.name)).toEqual([
        'db.migrations.read',
        'db.migrations.apply',
        'db.migrations.pending',
      ]);
      expect(spans[0]?.attributes).toEqual({ 'failure.code': MigrationReadFailed.code });
      expect(spans[0]?.status.code).toBe(SpanStatusCode.ERROR);
      expect(spans[1]?.attributes).toEqual({});
      expect(spans[2]?.attributes).toEqual({});
      expect(spans.flatMap(span => span.events)).toEqual([]);
    } finally {
      trace.disable();
      await provider.shutdown();
    }
  });

  it('returns an unreadable source before any SQL and keeps the private path off the wire', async () => {
    const opened = open();
    const migrationsFolder = absentFolder();
    const read = readMigrations(migrationsFolder);
    expect(MigrationReadFailed.is(read)).toBe(true);
    expect(JSON.stringify(read)).not.toContain(migrationsFolder);
    expect(MigrationReadFailed.is(await migrateDb(opened.db, { migrationsFolder }))).toBe(true);
    expect(await opened.db.all(sql`select name from sqlite_master where type = 'table'`)).toEqual([]);
  });

  it('returns a state-read failure when the native connection is closed', async () => {
    const opened = open();
    opened.close();
    expect(MigrationStateFailed.is(await pendingMigrations(opened.db, { migrations: [migration] }))).toBe(true);
  });

  it('distinguishes a preparation defect from an unconfirmed database write', async () => {
    const opened = open();
    const privateCause = new Error('private option getter');
    const result = await migrateDb(opened.db, {
      migrations: [migration],
      get migrationsTable(): string {
        throw privateCause;
      },
    });
    expect(UnexpectedDefect.is(result)).toBe(true);
    if (!UnexpectedDefect.is(result)) throw new Error('Expected a preparation defect');
    expect(result.cause).toBe(privateCause);
    expect(await opened.db.all(sql`select name from sqlite_master where type = 'table'`)).toEqual([]);
  });

  it('returns a defect for malformed stored bookkeeping rows instead of inventing a pending list', async () => {
    const opened = open();
    await opened.db.run(sql`create table __drizzle_migrations (wrong_column text)`);
    await opened.db.run(sql`insert into __drizzle_migrations values ('private stored value')`);
    const result = await pendingMigrations(opened.db, { migrations: [migration] });
    expect(UnexpectedDefect.is(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private stored value');
  });

  it('returns uncertainty after a committed transaction loses its acknowledgement and never repeats it', async () => {
    const client = createClient({ url: ':memory:' });
    closes.push(() => client.close());
    const handle = drizzle({ client });
    const transaction = client.transaction.bind(client);
    const privateCause = new Error('private acknowledgement loss');
    let commits = 0;
    vi.spyOn(client, 'transaction').mockImplementation(async (...args) => {
      const transactionHandle = await transaction(...args);
      const commit = transactionHandle.commit.bind(transactionHandle);
      vi.spyOn(transactionHandle, 'commit').mockImplementation(async () => {
        commits++;
        await commit();
        throw privateCause;
      });
      return transactionHandle;
    });
    const result = await migrateDb(handle, { migrations: [migration] });
    expect(MigrationUnconfirmed.is(result)).toBe(true);
    if (!MigrationUnconfirmed.is(result)) throw new Error('Expected an unconfirmed migration');
    expect(result.cause).toBe(privateCause);
    expect(JSON.stringify(result)).not.toContain(privateCause.message);
    expect(commits).toBe(1);
    expect(await handle.all(sql`select * from owned`)).toEqual([{ value: 1 }]);
  });

  it('returns uncertainty on a real SQL rejection and leaves reconciliation to the caller', async () => {
    const opened = open();
    const result = await migrateDb(opened.db, {
      migrations: [{ ...migration, sql: ['INVALID SQL private statement'] }],
    });
    expect(MigrationUnconfirmed.is(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private statement');
  });

  it('stops Dot boot before dependent work when migration source cannot be read', async () => {
    const dependent = vi.fn();
    const result = await defineApp('migration-source-refusal')
      .infra(db({ driver: 'pglite', memory: true, relations: defineRelations({}) }))
      .infra(dbMigrations({ migrationsFolder: absentFolder() }))
      .infra(infra({ name: 'dependent', boot: dependent }))
      .boot();
    expect(isFailure(result)).toBe(true);
    expect(MigrationReadFailed.is(result)).toBe(true);
    expect(dependent).not.toHaveBeenCalled();
  });
});
