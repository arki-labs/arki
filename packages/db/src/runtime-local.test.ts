/**
 * The PGlite owner lock. PGlite has no lock of its own, and two handles on
 * one data directory corrupt it. These tests prove the lock turns a second
 * opener into a loud error with the owner's pid, and that a lock never
 * outlives its owner: confirmed close and a dead process give the directory
 * back. Unconfirmed failed-start cleanup conservatively retains ownership.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Extension } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RandomSourceUnavailable } from '@arki/contracts';
import { orThrow, UnexpectedDefect } from '@arki/failure';

import { lockableDataDir, ownerId } from './owner-lock.js';
import { DataDirInUse, initDbRuntimeLocal, LocalRuntimeCleanupFailed } from './runtime-local.js';

const relations = {};
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'arki-db-lock-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

const lockFile = () => path.join(dir, '.arki-owner');
const plantLock = (holder: { pid: number; at: number }) =>
  writeFile(lockFile(), JSON.stringify({ ...holder, id: 'planted' }));
const lockExists = () =>
  readFile(lockFile(), 'utf8').then(
    () => true,
    () => false,
  );

/** The pid of a process that has exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '']);
  expect(child.pid).toBeGreaterThan(0);
  return child.pid;
}

describe('initDbRuntimeLocal owner lock', () => {
  it('refuses a second handle on a directory that is open, naming the pid, until the first one closes', async () => {
    const first = await orThrow(initDbRuntimeLocal({ dataDir: dir }, { relations }));

    const second = await initDbRuntimeLocal({ dataDir: dir }, { relations });
    expect(DataDirInUse.is(second)).toBe(true);
    expect(second).toMatchObject({ data: { pid: process.pid } });

    await first.pglite.close();
    expect(await lockExists()).toBe(false);

    const reopened = await orThrow(initDbRuntimeLocal({ dataDir: dir }, { relations }));
    await reopened.pglite.close();
  });

  it('refuses a directory held by another live process and leaves its lock alone', async () => {
    await plantLock({ pid: process.ppid, at: Date.now() });

    expect(await initDbRuntimeLocal({ dataDir: dir }, { relations })).toMatchObject({
      code: DataDirInUse.code,
      data: { pid: process.ppid },
    });
    expect(JSON.parse(await readFile(lockFile(), 'utf8'))).toMatchObject({ pid: process.ppid });
  });

  it('takes over a lock left by a process that is gone', async () => {
    await plantLock({ pid: deadPid(), at: Date.now() });

    const opened = await orThrow(initDbRuntimeLocal({ dataDir: dir }, { relations }));
    expect(JSON.parse(await readFile(lockFile(), 'utf8'))).toMatchObject({ pid: process.pid });
    await opened.pglite.close();
    expect(await lockExists()).toBe(false);
  });

  it('takes over our own pid from before this process started (a container restarts as the same pid)', async () => {
    await plantLock({ pid: process.pid, at: 0 });

    const opened = await orThrow(initDbRuntimeLocal({ dataDir: dir }, { relations }));
    await opened.pglite.close();
  });

  it('retains ownership when failed readiness cannot confirm extension cleanup', async () => {
    const broken: Extension = {
      name: 'broken',
      setup: () => Promise.reject(new Error('extension setup failed')),
    };

    const failure = await initDbRuntimeLocal({ dataDir: dir, extensions: { broken } }, { relations });
    expect(failure).toMatchObject({ code: LocalRuntimeCleanupFailed.code });
    if (!LocalRuntimeCleanupFailed.is(failure) || !(failure.cause instanceof AggregateError))
      throw new Error('Expected startup and cleanup causes');
    expect(failure.cause.errors).toMatchObject([
      { code: UnexpectedDefect.code, cause: { message: 'extension setup failed' } },
      { code: LocalRuntimeCleanupFailed.code },
    ]);
    expect(await lockExists()).toBe(true);
  });

  it('takes no lock for memory:// and browser storage', async () => {
    expect(lockableDataDir('memory://')).toBeNull();
    expect(lockableDataDir('idb://app')).toBeNull();
    expect(lockableDataDir('opfs-ahp://app')).toBeNull();
    expect(lockableDataDir('file:///tmp/app')).toBe('/tmp/app');
    expect(lockableDataDir('./.local/db')).toBe('./.local/db');

    const [a, b] = await Promise.all([
      initDbRuntimeLocal({ memory: true }, { relations }),
      initDbRuntimeLocal({ memory: true }, { relations }),
    ]);
    await Promise.all([orThrow(orThrow(a).close()), orThrow(orThrow(b).close())]);
  });

  it('returns the original entropy failure before creating a data directory', async () => {
    const failure = RandomSourceUnavailable();
    vi.spyOn(ownerId, 'create').mockReturnValue(failure);
    const nested = path.join(dir, 'not-created');
    expect(await initDbRuntimeLocal({ dataDir: nested }, { relations })).toBe(failure);
    expect(await readdir(dir)).toEqual([]);
  });

  it('memory explicitly bypasses owner entropy even when a disk path is provided', async () => {
    vi.stubGlobal('crypto', void 0);
    const opened = await orThrow(initDbRuntimeLocal({ memory: true, dataDir: dir }, { relations }));
    expect(await lockExists()).toBe(false);
    await orThrow(opened.close());
  });

  it('lets exactly one of several processes take over the same stale lock', async () => {
    await plantLock({ pid: deadPid(), at: Date.now() });
    const ownerLock = fileURLToPath(new URL('owner-lock.ts', import.meta.url));
    const script = path.join(dir, 'race.ts');
    await writeFile(
      script,
      [
        `import { acquireOwnerLock } from ${JSON.stringify(ownerLock)};`,
        'try {',
        '  const lock = await acquireOwnerLock(process.argv[2]);',
        "  if (typeof lock !== 'function') { process.stdout.write(lock.code); process.exit(0); }",
        "  process.stdout.write('owner');",
        '  await new Promise(resolve => setTimeout(resolve, 1500));',
        '} catch (error) {',
        "  process.stdout.write(error instanceof Error && 'code' in error ? String(error.code) : String(error));",
        '}',
      ].join('\n'),
    );

    const outcomes = await Promise.all(
      Array.from(
        { length: 4 },
        () =>
          new Promise<string>((resolve, reject) => {
            const child = spawn('bun', [script, dir], { stdio: ['ignore', 'pipe', 'inherit'] });
            let out = '';
            child.stdout.on('data', (chunk: Buffer) => {
              out += chunk.toString();
            });
            child.on('error', reject);
            child.on('close', () => {
              resolve(out);
            });
          }),
      ),
    );

    expect(outcomes.filter(outcome => outcome === 'owner')).toHaveLength(1);
    expect(outcomes.filter(outcome => outcome === DataDirInUse.code)).toHaveLength(3);
  }, 20_000);
});
