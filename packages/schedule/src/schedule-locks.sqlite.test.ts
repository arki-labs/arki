/**
 * Locked schedules on a real SQLite lease store: two schedulers (two Dot apps), each with its
 * own libSQL client on one database file, as two processes on one host would run.
 *
 * Why: an app on SQLite has no Postgres to hold its locks. The job must still run once per tick
 * across every scheduler that shares the file, and the next tick must run again once the
 * holder is done. The handle comes from `createLibsqlDb`, as an app's would, so the lock
 * writes take their turn in @arki/db's write queue.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defineRelations } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { DotApp } from '@arki/dot';
import type { Failure } from '@arki/failure';
import { createLibsqlDb } from '@arki/db/libsql';
import { defineFeature, entrypointOnly } from '@arki/dot/feature';
import { defineApp, infra } from '@arki/dot/unit';
import { orThrow } from '@arki/failure';
import { createLocks } from '@arki/lock';
import { ensureLockTable, sqliteLease } from '@arki/lock/sqlite';

import type { ScheduleRun } from './index.js';
import { schedule, schedules } from './dot.js';

const TTL = '2s';
const relations = defineRelations({});
const dir = mkdtempSync(path.join(tmpdir(), 'arki-schedule-sqlite-'));
const url = `file:${path.join(dir, 'locks.db')}`;

const closers: (() => void)[] = [];
const running: Pick<DotApp<Record<string, never>, Failure>, 'dispose'>[] = [];

beforeAll(async () => {
  const setup = createLibsqlDb({ url, relations });
  closers.push(setup.close);
  await ensureLockTable(setup.db);
});

afterEach(async () => {
  await Promise.all(running.splice(0).map(app => orThrow(app.dispose())));
});

afterAll(() => {
  for (const close of closers) close();
  rmSync(dir, { recursive: true, force: true });
});

type Work = (scheduler: string, run: ScheduleRun) => Promise<string>;

/** One scheduler: its own libSQL client and lease store, the same schedule and lock key as the other. */
async function scheduler(name: string, work: Work) {
  const opened = createLibsqlDb({ url, relations });
  closers.push(opened.close);
  const lockService = createLocks({ store: sqliteLease(opened.db, { ttl: TTL }), namespace: 'host' });
  const lockUnit = infra({ name: 'locks', provides: { locks: () => lockService } });
  // The scheduler takes the lock around the run; the handler never touches it.
  const core = defineFeature('reports')
    .needs({ locks: entrypointOnly(lockUnit.provides.locks) })
    .usecases({});
  const reports = core.entrypoints(
    schedules(core, [
      { name: 'nightly-report', cron: '0 3 * * *', lock: { holdAtLeast: 0 }, handler: (_deps, run) => work(name, run) },
    ]),
  );
  const started = await orThrow(
    defineApp(`reports-${name}`)
      .infra(lockUnit)
      .features([reports])
      .entrypoints(schedule({ clock: 'host' }))
      .start(),
  );
  running.push(started);
  return { name, trigger: () => started.services.scheduler.trigger('nightly-report') };
}

describe('a locked schedule on two schedulers sharing one SQLite file', () => {
  it('the same tick on both runs once; the other skips on the held lock', async () => {
    const release = Promise.withResolvers<void>();
    const ran: string[] = [];
    const work: Work = async name => {
      ran.push(name);
      await release.promise;
      return name;
    };
    const both = await Promise.all(['a', 'b'].map(name => scheduler(name, work)));
    const ticks = both.map(each => each.trigger());
    await vi.waitFor(() => expect(ran).toHaveLength(1));
    release.resolve();
    const outcomes = await Promise.all(ticks);
    expect(outcomes.map(outcome => outcome.status).toSorted()).toEqual(['ran', 'skipped-lock']);
    expect(ran).toHaveLength(1);
  });

  it('once the holder finishes, the next tick on the other scheduler runs, with a higher fence', async () => {
    const fences: bigint[] = [];
    const work: Work = (name, run) => {
      if (run.lock?.fence !== undefined) fences.push(run.lock.fence);
      return Promise.resolve(name);
    };
    const [a, b] = await Promise.all([scheduler('a', work), scheduler('b', work)]);
    await expect(a.trigger()).resolves.toMatchObject({ status: 'ran', value: 'a' });
    await expect(b.trigger()).resolves.toMatchObject({ status: 'ran', value: 'b' });
    expect(fences).toHaveLength(2);
    expect(fences[1]).toBeGreaterThan(fences[0] ?? 0n);
  });
});
