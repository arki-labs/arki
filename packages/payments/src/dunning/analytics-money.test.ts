/**
 * Money in dunning analytics
 *
 * Why it matters: a dunning campaign can recover payments in several
 * currencies, and these totals feed revenue figures. Two currencies must stay
 * apart, and the minor-unit columns must give back exactly what was written.
 */
import { describe, expect, it } from 'vitest';

import { money } from '@arki/money';

import { fromMinorColumn, toMinorColumn } from '../core/money';
import { createDunningCampaignId } from './primitives';
import { analyticsRowId, sumMinorByCurrency } from './analytics-money';

describe('sumMinorByCurrency', () => {
  it('never adds two currencies together', () => {
    const bag = sumMinorByCurrency([
      { currency: 'USD', units: '1999' },
      { currency: 'EUR', units: 500 },
      { currency: 'usd', units: 1 },
    ]);

    expect(bag.get('USD').toString()).toBe('20 USD');
    expect(bag.get('EUR').toString()).toBe('5 EUR');
    expect(bag.currencies().map(c => c.code)).toEqual(['EUR', 'USD']);
  });

  it('is empty when nothing was recovered', () => {
    expect(sumMinorByCurrency([]).isZero()).toBe(true);
  });

  it('reads units in the currency scale: JPY has no decimals', () => {
    expect(sumMinorByCurrency([{ currency: 'JPY', units: 1500 }]).get('JPY').toString()).toBe('1500 JPY');
  });
});

describe('minor-unit columns', () => {
  it('round-trip an amount a float4 column would have blurred', () => {
    // 16,777,217.01 is past what a `real` (about 7 digits) can hold.
    const amount = money('16777217.01', 'USD');

    expect(toMinorColumn(amount)).toBe(1_677_721_701);
    expect(fromMinorColumn(toMinorColumn(amount), 'USD').toJSON()).toEqual(amount.toJSON());
  });
});

describe('analyticsRowId', () => {
  it('differs per currency so one day never mixes two currencies in a row', () => {
    const campaign = createDunningCampaignId();

    expect(analyticsRowId(campaign, '2026-10-13', 'usd')).toBe(`${campaign}-2026-10-13-USD`);
    expect(analyticsRowId(campaign, '2026-10-13', 'EUR')).not.toBe(analyticsRowId(campaign, '2026-10-13', 'USD'));
  });
});
