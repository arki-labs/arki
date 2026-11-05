import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ProgressData as DelProgressData } from 'del';
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';

import type { FailureIn } from '@arki/failure';
import { UnexpectedDefect } from '@arki/failure';

import type { StorageWriteUncertain } from '../storage/failures.js';
import type { Options, ProgressData } from './delete.js';
import { StorageCancelled, StorageRejected } from '../storage/failures.js';
import { deleteAsync, deleteSync } from './delete.js';
import { glob, globIterate, globStream } from './glob.js';
import { writeToTheFileEnd } from './write.js';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await chmod(directory, 0o755);
    await rm(directory, { recursive: true, force: true });
  }
});

async function tempDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), 'arki-fs-local-'));
  directories.push(directory);
  return directory;
}

describe('writeToTheFileEnd', () => {
  it('appends to the end of the file, creating it first', async () => {
    const file = path.join(await tempDirectory(), 'log.txt');
    expect(await writeToTheFileEnd(file, 'one\n')).toBeUndefined();
    expect(await writeToTheFileEnd(file, 'two\n')).toBeUndefined();
    expect(await readFile(file, 'utf8')).toBe('one\ntwo\n');
  });

  // Nothing was written, so the caller can fix the path and retry without reconciling.
  it('returns StorageRejected for a missing directory instead of rejecting with ENOENT', async () => {
    const result = await writeToTheFileEnd(path.join(await tempDirectory(), 'missing', 'file'), 'x');
    expect(StorageRejected.is(result)).toBe(true);
  });

  it('returns StorageRejected for a read-only file', async () => {
    const file = path.join(await tempDirectory(), 'locked.txt');
    await writeFile(file, 'kept');
    await chmod(file, 0o444);
    expect(StorageRejected.is(await writeToTheFileEnd(file, 'x'))).toBe(true);
    expect(await readFile(file, 'utf8')).toBe('kept');
  });

  it('declares a refusal and an unconfirmed write, nothing else', () => {
    expectTypeOf<FailureIn<Awaited<ReturnType<typeof writeToTheFileEnd>>>>().toEqualTypeOf<
      ReturnType<typeof StorageRejected> | ReturnType<typeof StorageWriteUncertain>
    >();
  });
});

describe('deleteAsync', () => {
  it('deletes the matching paths inside cwd and returns them', async () => {
    const directory = await tempDirectory();
    await writeFile(path.join(directory, 'a.tmp'), 'a');
    await writeFile(path.join(directory, 'b.keep'), 'b');
    const deleted = await deleteAsync('*.tmp', { cwd: directory });
    expect(deleted).toEqual([path.join(directory, 'a.tmp')]);
    const kept = await stat(path.join(directory, 'b.keep'));
    expect(kept.isFile()).toBe(true);
  });

  // del's guard keeps a stray pattern from deleting outside the project; that refusal is a value now.
  it('returns StorageRejected for a path outside the working directory and deletes nothing', async () => {
    const file = path.join(await tempDirectory(), 'outside.txt');
    await writeFile(file, 'kept');
    expect(StorageRejected.is(await deleteAsync(file))).toBe(true);
    expect(await readFile(file, 'utf8')).toBe('kept');
  });

  it('returns StorageRejected when the directory denies the delete', async () => {
    const directory = await tempDirectory();
    const locked = path.join(directory, 'locked');
    await mkdir(locked);
    await writeFile(path.join(locked, 'file.txt'), 'kept');
    await chmod(locked, 0o555);
    try {
      expect(StorageRejected.is(await deleteAsync('locked/file.txt', { cwd: directory }))).toBe(true);
    } finally {
      await chmod(locked, 0o755);
    }
    expect(await readFile(path.join(locked, 'file.txt'), 'utf8')).toBe('kept');
  });

  it('declares a refusal and an unconfirmed delete, nothing else', () => {
    expectTypeOf<FailureIn<Awaited<ReturnType<typeof deleteAsync>>>>().toEqualTypeOf<
      ReturnType<typeof StorageRejected> | ReturnType<typeof StorageWriteUncertain>
    >();
  });
});

describe('glob', () => {
  it('lists the matching paths and gives no matches for a missing directory', async () => {
    const directory = await tempDirectory();
    await writeFile(path.join(directory, 'a.txt'), 'a');
    expect(await glob('*.txt', { cwd: directory })).toEqual(['a.txt']);
    expect(await glob('*', { cwd: path.join(directory, 'missing') })).toEqual([]);
  });

  it('returns StorageCancelled when the signal aborts', async () => {
    const result = await glob('*', { cwd: await tempDirectory(), signal: AbortSignal.abort() });
    expect(StorageCancelled.is(result)).toBe(true);
  });

  it('returns UnexpectedDefect for an invalid option set instead of rejecting with a TypeError', async () => {
    const result = await glob('*', { cwd: await tempDirectory(), noglobstar: true, matchBase: true });
    expect(UnexpectedDefect.is(result)).toBe(true);
  });
});

describe('deleteSync', () => {
  it('deletes the matching paths inside cwd and returns them', async () => {
    const directory = await tempDirectory();
    await writeFile(path.join(directory, 'a.tmp'), 'a');
    await writeFile(path.join(directory, 'b.keep'), 'b');
    expect(deleteSync('*.tmp', { cwd: directory })).toEqual([path.join(directory, 'a.tmp')]);
    const kept = await stat(path.join(directory, 'b.keep'));
    expect(kept.isFile()).toBe(true);
  });

  it('returns StorageRejected for a path outside the working directory and deletes nothing', async () => {
    const file = path.join(await tempDirectory(), 'outside.txt');
    await writeFile(file, 'kept');
    expect(StorageRejected.is(deleteSync(file))).toBe(true);
    expect(await readFile(file, 'utf8')).toBe('kept');
  });

  it('returns StorageRejected when the directory denies the delete', async () => {
    const directory = await tempDirectory();
    const locked = path.join(directory, 'locked');
    await mkdir(locked);
    await writeFile(path.join(locked, 'file.txt'), 'kept');
    await chmod(locked, 0o555);
    try {
      expect(StorageRejected.is(deleteSync('locked/file.txt', { cwd: directory }))).toBe(true);
    } finally {
      await chmod(locked, 0o755);
    }
    expect(await readFile(path.join(locked, 'file.txt'), 'utf8')).toBe('kept');
  });

  it('declares the same failures as deleteAsync', () => {
    expectTypeOf<FailureIn<ReturnType<typeof deleteSync>>>().toEqualTypeOf<
      FailureIn<Awaited<ReturnType<typeof deleteAsync>>>
    >();
  });
});

describe('ProgressData', () => {
  it('is the type del reports to onProgress', async () => {
    expectTypeOf<ProgressData>().toEqualTypeOf<DelProgressData>();
    expectTypeOf<Parameters<NonNullable<Options['onProgress']>>[0]>().toEqualTypeOf<ProgressData>();
    const directory = await tempDirectory();
    await writeFile(path.join(directory, 'a.tmp'), 'a');
    const seen: ProgressData[] = [];
    expect(await deleteAsync('*.tmp', { cwd: directory, onProgress: progress => seen.push(progress) })).toEqual([
      path.join(directory, 'a.tmp'),
    ]);
    expect(seen.at(-1)).toMatchObject({ deletedCount: 1, totalCount: 1, percent: 1 });
  });
});

/** Drains a generator, returning what it yielded and what it returned. */
async function drain(paths: ReturnType<typeof globIterate>) {
  const yielded: string[] = [];
  let next = await paths.next();
  for (; !next.done; next = await paths.next()) yielded.push(next.value);
  return { yielded, returned: next.value };
}

describe('globIterate', () => {
  it('yields every matching path and returns undefined', async () => {
    const directory = await tempDirectory();
    await writeFile(path.join(directory, 'a.txt'), 'a');
    await writeFile(path.join(directory, 'b.txt'), 'b');
    const { yielded, returned } = await drain(globIterate('*.txt', { cwd: directory }));
    expect(yielded.toSorted()).toEqual(['a.txt', 'b.txt']);
    expect(returned).toBeUndefined();
  });

  // The caller learns why the walk stopped from the return value, never from a rejected next().
  it('returns StorageCancelled when the signal aborts', async () => {
    const { returned } = await drain(globIterate('*', { cwd: await tempDirectory(), signal: AbortSignal.abort() }));
    expect(StorageCancelled.is(returned)).toBe(true);
  });

  it('returns UnexpectedDefect for an invalid option set', async () => {
    const { returned } = await drain(
      globIterate('*', { cwd: await tempDirectory(), noglobstar: true, matchBase: true }),
    );
    expect(UnexpectedDefect.is(returned)).toBe(true);
  });
});

/** Reads a stream to its end. */
async function chunks(stream: ReturnType<typeof globStream>) {
  const reader = stream.getReader();
  const read: Awaited<ReturnType<typeof reader.read>>['value'][] = [];
  for (let next = await reader.read(); !next.done; next = await reader.read()) read.push(next.value);
  return read;
}

describe('globStream', () => {
  it('emits every matching path and closes', async () => {
    const directory = await tempDirectory();
    await writeFile(path.join(directory, 'a.txt'), 'a');
    expect(await chunks(globStream('*.txt', { cwd: directory }))).toEqual(['a.txt']);
  });

  it('emits StorageCancelled as its last chunk when the signal aborts, without erroring', async () => {
    const read = await chunks(globStream('*', { cwd: await tempDirectory(), signal: AbortSignal.abort() }));
    expect(read).toHaveLength(1);
    expect(StorageCancelled.is(read[0])).toBe(true);
  });

  it('emits UnexpectedDefect as its last chunk for an invalid option set', async () => {
    const read = await chunks(globStream('*', { cwd: await tempDirectory(), noglobstar: true, matchBase: true }));
    expect(read).toHaveLength(1);
    expect(UnexpectedDefect.is(read[0])).toBe(true);
  });
});
