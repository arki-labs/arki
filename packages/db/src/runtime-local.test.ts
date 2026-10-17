/**
 * The PGlite owner lock. PGlite has no lock of its own, and two handles on
 * one data directory corrupt it. These tests prove the lock turns a second
 * opener into a loud error with the owner's pid, and that a lock never
 * outlives its owner: closing, a failed start and a dead process all give
 * the directory back.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Extension } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { lockableDataDir } from './owner-lock.js';
import { DB_RUNTIME_LOCAL_ERROR_CODES, DbRuntimeLocalError, initDbRuntimeLocal } from './runtime-local.js';

const relations = {};
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'arki-db-lock-'));
});

afterEach(async () => {
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
    const first = await initDbRuntimeLocal({ dataDir: dir }, { relations });

    const second = initDbRuntimeLocal({ dataDir: dir }, { relations });
    await expect(second).rejects.toBeInstanceOf(DbRuntimeLocalError);
    await expect(second).rejects.toMatchObject({
      code: DB_RUNTIME_LOCAL_ERROR_CODES.dataDirInUse,
      pid: process.pid,
    });

    await first.pglite.close();
    expect(await lockExists()).toBe(false);

    const reopened = await initDbRuntimeLocal({ dataDir: dir }, { relations });
    await reopened.pglite.close();
  });

  it('refuses a directory held by another live process and leaves its lock alone', async () => {
    await plantLock({ pid: process.ppid, at: Date.now() });

    await expect(initDbRuntimeLocal({ dataDir: dir }, { relations })).rejects.toMatchObject({
      code: DB_RUNTIME_LOCAL_ERROR_CODES.dataDirInUse,
      pid: process.ppid,
    });
    expect(JSON.parse(await readFile(lockFile(), 'utf8'))).toMatchObject({ pid: process.ppid });
  });

  it('takes over a lock left by a process that is gone', async () => {
    await plantLock({ pid: deadPid(), at: Date.now() });

    const opened = await initDbRuntimeLocal({ dataDir: dir }, { relations });
    expect(JSON.parse(await readFile(lockFile(), 'utf8'))).toMatchObject({ pid: process.pid });
    await opened.pglite.close();
    expect(await lockExists()).toBe(false);
  });

  it('takes over our own pid from before this process started (a container restarts as the same pid)', async () => {
    await plantLock({ pid: process.pid, at: 0 });

    const opened = await initDbRuntimeLocal({ dataDir: dir }, { relations });
    await opened.pglite.close();
  });

  it('gives the lock back when PGlite fails to start', async () => {
    const broken: Extension = {
      name: 'broken',
      setup: () => Promise.reject(new Error('extension setup failed')),
    };

    await expect(initDbRuntimeLocal({ dataDir: dir, extensions: { broken } }, { relations })).rejects.toThrow();
    expect(await lockExists()).toBe(false);
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
    await Promise.all([a.pglite.close(), b.pglite.close()]);
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
        '  await acquireOwnerLock(process.argv[2]);',
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
    expect(outcomes.filter(outcome => outcome === DB_RUNTIME_LOCAL_ERROR_CODES.dataDirInUse)).toHaveLength(3);
  }, 20_000);
});
