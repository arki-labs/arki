/** A failed owned close must retain a possibly live database's owner lock. */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type * as PgliteDriver from 'drizzle-orm/pglite';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RandomSourceUnavailable } from '@arki/contracts';
import { orThrow, UnexpectedDefect, UnexpectedFailure } from '@arki/failure';

import type * as OwnerLock from './owner-lock.js';
import type { LocalRuntimeCloseFailure } from './runtime-local-failures.js';
import { DataDirInUse, initDbRuntimeLocal, LocalRuntimeCleanupFailed } from './runtime-local.js';

const faults = vi.hoisted(() => {
  const state: { releaseFailure?: LocalRuntimeCloseFailure; drizzleFailure?: Error } = {};
  return state;
});
vi.mock('./owner-lock.js', async importOriginal => {
  const actual = await importOriginal<typeof OwnerLock>();
  return {
    ...actual,
    acquireOwnerLock: async (dataDir: string) => {
      const acquired = await actual.acquireOwnerLock(dataDir);
      if (typeof acquired !== 'function') return acquired;
      return () => (faults.releaseFailure === undefined ? acquired() : Promise.resolve(faults.releaseFailure));
    },
  };
});
vi.mock('drizzle-orm/pglite', async importOriginal => {
  const actual = await importOriginal<typeof PgliteDriver>();
  return {
    ...actual,
    drizzle: (...args: Parameters<typeof actual.drizzle>) => {
      if (faults.drizzleFailure !== undefined) throw faults.drizzleFailure;
      return actual.drizzle(...args);
    },
  };
});

let dir: string;
const relations = {};
const lockExists = () =>
  readFile(path.join(dir, '.arki-owner'), 'utf8').then(
    () => true,
    () => false,
  );
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'arki-db-cleanup-'));
});
afterEach(async () => {
  delete faults.releaseFailure;
  delete faults.drizzleFailure;
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('owned local runtime cleanup', () => {
  it('retains the owner after failed driver close and supports a later successful retry', async () => {
    const opened = await orThrow(initDbRuntimeLocal({ dataDir: dir }, { relations }));
    const cause = new Error('driver close refused');
    vi.spyOn(PGlite.prototype, 'close').mockRejectedValueOnce(cause);
    expect(await opened.close()).toMatchObject({ code: LocalRuntimeCleanupFailed.code, cause });
    expect(opened.pglite.closed).toBe(false);
    expect(await lockExists()).toBe(true);
    expect(await initDbRuntimeLocal({ dataDir: dir }, { relations })).toMatchObject({ code: DataDirInUse.code });
    await orThrow(opened.close());
    expect(await lockExists()).toBe(false);
    await orThrow(opened.close());
  });

  it('preserves the exact release failure and retries it after the database has closed', async () => {
    const opened = await orThrow(initDbRuntimeLocal({ dataDir: dir }, { relations }));
    const failure = LocalRuntimeCleanupFailed({ cause: new Error('lock removal failed') });
    faults.releaseFailure = failure;
    expect(await opened.close()).toBe(failure);
    expect(opened.pglite.closed).toBe(true);
    expect(await lockExists()).toBe(true);
    delete faults.releaseFailure;
    await orThrow(opened.close());
    expect(await lockExists()).toBe(false);
  });

  it('restores a canonical cleanup failure thrown by the foreign driver bridge', async () => {
    const opened = await orThrow(initDbRuntimeLocal({ dataDir: dir }, { relations }));
    const failure = LocalRuntimeCleanupFailed({ cause: new Error('driver cleanup failed') });
    vi.spyOn(PGlite.prototype, 'close').mockRejectedValueOnce(new UnexpectedFailure(failure));
    expect(await opened.close()).toBe(failure);
    expect(await lockExists()).toBe(true);
    await orThrow(opened.close());
  });

  it('cleans up an opened PGlite when Drizzle construction fails', async () => {
    const cause = new Error('Drizzle construction failed');
    faults.drizzleFailure = cause;
    expect(await initDbRuntimeLocal({ dataDir: dir }, { relations })).toMatchObject({
      code: UnexpectedDefect.code,
      cause,
    });
    expect(await lockExists()).toBe(false);
  });

  it('preserves the exact declared startup failure when cleanup succeeds', async () => {
    const failure = RandomSourceUnavailable();
    faults.drizzleFailure = new UnexpectedFailure(failure);
    expect(await initDbRuntimeLocal({ dataDir: dir }, { relations })).toBe(failure);
    expect(await lockExists()).toBe(false);
  });

  it('preserves startup and cleanup failures together and retains unconfirmed ownership', async () => {
    const cause = new Error('Drizzle construction failed');
    const cleanup = LocalRuntimeCleanupFailed({ cause: new Error('lock release failed') });
    faults.releaseFailure = cleanup;
    faults.drizzleFailure = cause;
    const failure = await initDbRuntimeLocal({ dataDir: dir }, { relations });
    expect(failure).toMatchObject({ code: LocalRuntimeCleanupFailed.code });
    if (!LocalRuntimeCleanupFailed.is(failure)) throw new Error('Expected cleanup uncertainty');
    expect(failure.cause).toBeInstanceOf(AggregateError);
    if (!(failure.cause instanceof AggregateError)) throw new Error('Expected both failures');
    expect(failure.cause.errors).toMatchObject([{ code: UnexpectedDefect.code, cause }, cleanup]);
    expect(await lockExists()).toBe(true);
  });
});
