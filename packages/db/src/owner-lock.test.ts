/** The owner lock must work without hard links and retain ownership on failed release. */
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type * as fsPromises from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RandomSourceUnavailable } from '@arki/contracts';
import { orThrow, UnexpectedDefect } from '@arki/failure';

import { acquireOwnerLock, ownerId } from './owner-lock.js';
import {
  DataDirInUse,
  LocalRuntimeCleanupFailed,
  LocalRuntimeRefused,
  LocalRuntimeUnavailable,
  OwnerLockContended,
} from './runtime-local-failures.js';

const faults = vi.hoisted(() => ({
  mkdir: undefined as Error | undefined,
  release: undefined as Error | undefined,
  changing: false,
  noHardLinks: true,
  tempCleanup: undefined as Error | undefined,
  reclaimCleanup: undefined as Error | undefined,
}));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof fsPromises>();
  return {
    ...actual,
    mkdir: (...args: Parameters<typeof actual.mkdir>) =>
      faults.mkdir ? Promise.reject(faults.mkdir) : actual.mkdir(...args),
    link: (...args: Parameters<typeof actual.link>) =>
      faults.noHardLinks
        ? Promise.reject(Object.assign(new Error('operation not permitted'), { code: 'EPERM' }))
        : actual.link(...args),
    rm: (...args: Parameters<typeof actual.rm>) =>
      faults.tempCleanup && args[0].toString().endsWith('.tmp')
        ? Promise.reject(faults.tempCleanup)
        : faults.reclaimCleanup && args[0].toString().endsWith('.reclaim')
          ? Promise.reject(faults.reclaimCleanup)
          : faults.release && typeof args[0] === 'string' && args[0].endsWith('.arki-owner')
            ? Promise.reject(faults.release)
            : actual.rm(...args),
    writeFile: (...args: Parameters<typeof actual.writeFile>) =>
      faults.changing && typeof args[0] === 'string' && args[0].endsWith('.arki-owner')
        ? Promise.reject(Object.assign(new Error('exists'), { code: 'EEXIST' }))
        : actual.writeFile(...args),
    readFile: (...args: Parameters<typeof actual.readFile>) =>
      faults.changing && typeof args[0] === 'string' && args[0].endsWith('.arki-owner')
        ? Promise.reject(Object.assign(new Error('gone'), { code: 'ENOENT' }))
        : actual.readFile(...args),
  };
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'arki-db-nolink-'));
});
afterEach(async () => {
  faults.mkdir = undefined;
  faults.release = undefined;
  faults.changing = false;
  faults.noHardLinks = true;
  faults.tempCleanup = undefined;
  faults.reclaimCleanup = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

describe('acquireOwnerLock without hard links', () => {
  it('takes and refuses ownership, then releases exactly once', async () => {
    const release = await orThrow(acquireOwnerLock(dir));
    expect(JSON.parse(await readFile(path.join(dir, '.arki-owner'), 'utf8'))).toMatchObject({
      pid: process.pid,
      id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
    });
    expect(await acquireOwnerLock(dir)).toMatchObject({ code: DataDirInUse.code, data: { pid: process.pid } });
    await orThrow(release());
    await orThrow(release());
    await expect(readFile(path.join(dir, '.arki-owner'), 'utf8')).rejects.toThrow();
  });

  it('does not remove a replacement owner when the old release runs', async () => {
    const release = await orThrow(acquireOwnerLock(dir));
    const replacement = { pid: process.pid, at: Date.now(), id: 'older-format-owner' };
    await writeFile(path.join(dir, '.arki-owner'), JSON.stringify(replacement));
    await orThrow(release());
    expect(JSON.parse(await readFile(path.join(dir, '.arki-owner'), 'utf8'))).toEqual(replacement);
  });

  it('keeps a failed release retryable and retains the lock until removal succeeds', async () => {
    const release = await orThrow(acquireOwnerLock(dir));
    const cause = new Error('cannot remove lock');
    faults.release = cause;
    const result = await release();
    expect(result).toMatchObject({ code: LocalRuntimeCleanupFailed.code, cause });
    expect(await readdir(dir)).toContain('.arki-owner');
    faults.release = undefined;
    await orThrow(release());
    expect(await readdir(dir)).toEqual([]);
  });

  it('reports cleanup uncertainty when a linked lock exists but temporary removal fails', async () => {
    faults.noHardLinks = false;
    const cause = new Error('cannot remove temporary file');
    faults.tempCleanup = cause;
    expect(await acquireOwnerLock(dir)).toMatchObject({ code: LocalRuntimeCleanupFailed.code, cause });
    expect(await readdir(dir)).toContain('.arki-owner');
    faults.tempCleanup = undefined;
    expect(await acquireOwnerLock(dir)).toMatchObject({ code: DataDirInUse.code });
  });

  it('preserves reclaim and cleanup causes when both operations fail', async () => {
    await writeFile(path.join(dir, '.arki-owner'), 'invalid');
    const cause = new Error('cannot remove old owner');
    const cleanup = new Error('cannot release reclaim lock');
    faults.release = cause;
    faults.reclaimCleanup = cleanup;
    const failure = await acquireOwnerLock(dir);
    expect(LocalRuntimeCleanupFailed.is(failure)).toBe(true);
    if (!LocalRuntimeCleanupFailed.is(failure)) throw new Error('Expected cleanup uncertainty');
    expect(failure.cause).toBeInstanceOf(AggregateError);
    if (!(failure.cause instanceof AggregateError)) throw new Error('Expected both causes');
    expect(failure.cause.errors).toEqual([cause, cleanup]);
  });

  it('returns the exact canonical entropy failure without creating directories', async () => {
    const failure = RandomSourceUnavailable();
    vi.spyOn(ownerId, 'create').mockReturnValue(failure);
    const nested = path.join(dir, 'absent');
    expect(await acquireOwnerLock(nested)).toBe(failure);
    await expect(stat(nested)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(dir)).toEqual([]);
  });

  it.each([
    ['missing', undefined, RandomSourceUnavailable.code],
    [
      'fault',
      {
        randomUUID() {
          throw new Error('entropy defect');
        },
      },
      UnexpectedDefect.code,
    ],
  ])('returns %s entropy failures before writing any files', async (_name, crypto, code) => {
    vi.stubGlobal('crypto', crypto);
    expect(await acquireOwnerLock(dir)).toMatchObject({ code });
    expect(await readdir(dir)).toEqual([]);
  });

  it.each([
    ['EACCES', LocalRuntimeRefused.code],
    ['ENOSPC', LocalRuntimeUnavailable.code],
    ['UNKNOWN', UnexpectedDefect.code],
  ])('classifies filesystem %s without fabricating owner facts', async (code, expected) => {
    const cause = Object.assign(new Error('filesystem failed'), { code });
    faults.mkdir = cause;
    expect(await acquireOwnerLock(dir)).toMatchObject({ code: expected, cause });
    expect(await readdir(dir)).toEqual([]);
  });

  it('supervises hostile thrown error properties while retaining the original cause', async () => {
    const cause = Object.defineProperty(new Error('hostile error'), 'code', {
      get() {
        throw new Error('code getter failed');
      },
    });
    faults.mkdir = cause;
    expect(await acquireOwnerLock(dir)).toMatchObject({ code: UnexpectedDefect.code, cause });
  });

  it('reports exhausted contention without assuming an owner or retrying forever', async () => {
    faults.changing = true;
    expect(await acquireOwnerLock(dir)).toMatchObject({ code: OwnerLockContended.code });
    expect(await readdir(dir)).toEqual([]);
  });
});
