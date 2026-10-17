import { expect, it } from 'vitest';

import { overlap, sendInvoices } from './nightly.js';

it('runs once and tells the second caller the lock is busy', async () => {
  expect(await sendInvoices(async () => 2)).toBe('sent 2');
  expect(await overlap()).toEqual(['sent 3', 'skipped: another caller holds the lock']);
});
