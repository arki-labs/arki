/**
 * The owner lock on a file system without hard links (FAT, some network
 * mounts). `link()` fails there with EPERM; the lock must still work, or
 * PGlite could not open a data directory on such a disk at all.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type * as fsPromises from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { acquireOwnerLock, DB_RUNTIME_LOCAL_ERROR_CODES } from './owner-lock.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof fsPromises>();
  return {
    ...actual,
    link: () => Promise.reject(Object.assign(new Error('operation not permitted'), { code: 'EPERM' })),
  };
});

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'arki-db-nolink-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('acquireOwnerLock without hard links', () => {
  it('still takes, refuses and gives back the lock', async () => {
    const release = await acquireOwnerLock(dir);
    expect(JSON.parse(await readFile(path.join(dir, '.arki-owner'), 'utf8'))).toMatchObject({ pid: process.pid });

    await expect(acquireOwnerLock(dir)).rejects.toMatchObject({ code: DB_RUNTIME_LOCAL_ERROR_CODES.dataDirInUse });

    await release();
    await expect(readFile(path.join(dir, '.arki-owner'), 'utf8')).rejects.toThrow();
  });
});
