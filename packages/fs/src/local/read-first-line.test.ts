import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, expectTypeOf, it } from 'vitest';

import type { FailureIn, FailureOf } from '@arki/failure';

import type { FILE_READ_FAILURES } from '../storage/failures.js';
import { StorageCancelled, StorageNotFound } from '../storage/failures.js';
import { readFirstLine } from './read-first-line.js';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

it('settles at EOF instead of keeping an empty-file caller pending', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'arki-first-line-'));
  directories.push(directory);
  const file = path.join(directory, 'empty');
  await writeFile(file, '');
  expect(await readFirstLine(file)).toBeUndefined();
  await writeFile(file, 'first\nsecond\n');
  expect(await readFirstLine(file)).toBe('first');
  await writeFile(file, 'last without newline');
  expect(await readFirstLine(file)).toBe('last without newline');
});

it('owns a missing stream error and returns a precise absence', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'arki-first-line-'));
  directories.push(directory);
  expect(StorageNotFound.is(await readFirstLine(path.join(directory, 'missing')))).toBe(true);
});

it('does not open a stream after the caller already cancelled', async () => {
  expect(StorageCancelled.is(await readFirstLine('not-opened', { signal: AbortSignal.abort() }))).toBe(true);
});

it('retains exactly the declared file-read failures', () => {
  expectTypeOf<FailureIn<Awaited<ReturnType<typeof readFirstLine>>>>().toEqualTypeOf<
    FailureOf<(typeof FILE_READ_FAILURES)[number]>
  >();
});
