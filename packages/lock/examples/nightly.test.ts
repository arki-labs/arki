import { expect, it } from 'vitest';

import { overlap, grabLastSlice } from './nightly.js';

it('runs once and tells the second caller the lock is busy', async () => {
  expect(await grabLastSlice(async () => 2)).toBe('sent 2');
  expect(await overlap()).toEqual(['sent 3', 'skipped: someone else already has the last slice']);
});
