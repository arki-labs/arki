import { describe, expect, it } from 'vitest';

import { segmentCriteriaSchema } from './contracts';

describe('segmentCriteriaSchema totalSpent', () => {
  it('keeps the range as { amount, currency } JSON, because criteria are stored in a jsonb column', () => {
    const parsed = segmentCriteriaSchema.parse({
      totalSpent: { min: { amount: '100', currency: 'EUR' }, max: { amount: '1000.50', currency: 'EUR' } },
    });
    expect(parsed.totalSpent).toEqual({
      min: { amount: '100.00', currency: 'EUR' },
      max: { amount: '1000.50', currency: 'EUR' },
    });
  });

  it('rejects a range whose bounds use different currencies: totals are only summed within one currency', () => {
    const result = segmentCriteriaSchema.safeParse({
      totalSpent: { min: { amount: '100', currency: 'EUR' }, max: { amount: '1000', currency: 'USD' } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a negative bound and a bare number with no currency', () => {
    expect(segmentCriteriaSchema.safeParse({ totalSpent: { min: { amount: '-1', currency: 'EUR' } } }).success).toBe(
      false,
    );
    expect(segmentCriteriaSchema.safeParse({ totalSpent: { min: 100 } }).success).toBe(false);
  });
});
