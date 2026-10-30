import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

import { glob } from './glob.js';
import { writeToTheFileEnd } from './write.js';

it('write pass-through rejects with the raw Node system error, as its header documents', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'arki-fs-passthrough-'));
  try {
    await expect(writeToTheFileEnd(path.join(directory, 'missing', 'file'), 'x')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('glob pass-through yields no matches for a missing directory, as its header documents', async () => {
  expect(await glob('*', { cwd: path.join(tmpdir(), 'arki-fs-definitely-missing') })).toEqual([]);
});
