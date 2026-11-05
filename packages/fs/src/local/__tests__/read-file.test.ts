import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { encode } from 'iconv-lite';
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';

import type { FailureIn, FailureOf } from '@arki/failure';

import type { FILE_READ_FAILURES } from '../../storage/failures.js';
import { StorageCancelled, StorageNotFound, StorageRejected } from '../../storage/failures.js';
import { readFile } from '../read-file.js';

const FIXTURES_DIR = path.join(import.meta.dirname, 'fixtures');

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function tempFile(name: string, bytes: string | Uint8Array) {
  const directory = await mkdtemp(path.join(tmpdir(), 'arki-read-file-'));
  directories.push(directory);
  const file = path.join(directory, name);
  await writeFile(file, bytes);
  return file;
}

describe('readFile', () => {
  it('reads a UTF-8 file', async () => {
    const content = await readFile(path.join(FIXTURES_DIR, 'utf8.txt'), 'utf8');

    expect(content).toContain('Hello, World!');
    expect(content).toContain('UTF-8 encoded file');
    expect(content).toContain('áéíóú ñ € £ ¥');
  });

  it('decodes Latin-1 under both of its names, and Windows-1252', async () => {
    const latin1 = await tempFile('latin1.txt', encode('Héllo Wörld! Ñoño', 'latin1'));
    expect(await readFile(latin1, 'latin1')).toBe('Héllo Wörld! Ñoño');
    expect(await readFile(latin1, 'iso-8859-1')).toBe('Héllo Wörld! Ñoño');
    const win1252 = await tempFile('win1252.txt', encode('Windows encoding: "smart quotes" and €', 'win1252'));
    expect(await readFile(win1252, 'win1252')).toBe('Windows encoding: "smart quotes" and €');
  });

  it('reads an empty file as empty text', async () => {
    expect(await readFile(await tempFile('empty.txt', ''), 'utf8')).toBe('');
  });

  // Callers branch on the failure: a missing file is absence, not a crash at load time.
  it('returns StorageNotFound for a missing path instead of throwing ENOENT', async () => {
    const directory = path.dirname(await tempFile('present.txt', 'x'));
    const result = await readFile(path.join(directory, 'missing.txt'), 'utf8');
    expect(StorageNotFound.is(result)).toBe(true);
  });

  it('returns StorageRejected for an unknown encoding before reading the file', async () => {
    const result = await readFile(path.join(FIXTURES_DIR, 'utf8.txt'), 'no-such-encoding');
    expect(StorageRejected.is(result)).toBe(true);
  });

  it('returns StorageRejected when the path is a directory', async () => {
    const directory = path.dirname(await tempFile('present.txt', 'x'));
    expect(StorageRejected.is(await readFile(directory, 'utf8'))).toBe(true);
  });

  it('returns StorageCancelled and reads nothing after the caller cancelled', async () => {
    const result = await readFile(path.join(FIXTURES_DIR, 'utf8.txt'), 'utf8', { signal: AbortSignal.abort() });
    expect(StorageCancelled.is(result)).toBe(true);
  });

  it('declares exactly the file-read failures', () => {
    expectTypeOf<FailureIn<Awaited<ReturnType<typeof readFile>>>>().toEqualTypeOf<
      FailureOf<(typeof FILE_READ_FAILURES)[number]>
    >();
  });
});
