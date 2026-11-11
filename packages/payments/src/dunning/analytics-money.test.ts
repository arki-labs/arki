import { describe, expect, it } from 'vitest';

import { orThrow } from '@arki/failure';

import { analyticsRowId, sumMinorByCurrency } from './analytics-money.js';
import { createDunningCampaignId } from './primitives.js';

// Campaign analytics keep one row per currency and day; their recovered revenue is summed per
// currency and never across currencies, however many rows a date range returns.
describe('dunning analytics money', () => {
  it('keeps each currency apart', () => {
    const bag = orThrow(
      sumMinorByCurrency([
        { currency: 'USD', units: 150 },
        { currency: 'eur', units: '200' },
        { currency: 'USD', units: 50 },
      ]),
    );
    expect(bag.toJSON()).toEqual(
      expect.arrayContaining([
        { amount: '2', currency: 'USD' },
        { amount: '2', currency: 'EUR' },
      ]),
    );
  });

  it('sums 200,000 rows without a RangeError from spreading them', () => {
    const rows = Array.from({ length: 200_000 }, () => ({ currency: 'USD', units: 1 }));
    expect(orThrow(sumMinorByCurrency(rows)).toJSON()).toEqual([{ amount: '2000', currency: 'USD' }]);
  });

  it('refuses a row it cannot read as schema.invalid_input, and sums nothing', () => {
    const bad = [
      { currency: 'ZZZ', units: 1 },
      { currency: '\u0000', units: 1 },
      { currency: 'USD', units: 1.5 },
      { currency: 'USD', units: Number.NaN },
      { currency: 'USD', units: 2 ** 53 },
      { currency: 'USD', units: 'abc' },
      { currency: 'USD', units: '9'.repeat(1000) },
    ];
    for (const row of bad) {
      expect(sumMinorByCurrency([{ currency: 'USD', units: 1 }, row])).toMatchObject({ code: 'schema.invalid_input' });
    }
  });

  it('names a row by campaign, day and upper-case currency', () => {
    const campaignId = orThrow(createDunningCampaignId());
    expect(analyticsRowId(campaignId, '2026-11-09', 'usd')).toBe(`${campaignId}-2026-11-09-USD`);
  });
});
