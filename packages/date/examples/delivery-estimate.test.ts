import { describe, expect, it } from 'vitest';

import { describeDelivery, estimateDelivery } from './delivery-estimate.js';

describe('estimateDelivery', () => {
  it('counts business days from the order day and skips the 1 December holiday', () => {
    // Friday 27 Nov, 12:00 in Bucharest. Mon 30 Nov is day 1, Tue 1 Dec is a holiday, Wed 2 Dec is day 2, Thu 3 Dec is day 3.
    expect(String(estimateDelivery('2026-11-27T10:00:00Z', 'Europe/Bucharest', 3))).toBe('2026-12-03');
  });

  it('moves an order placed at 15:00 shop time to the next business day, and keeps one placed a second earlier', () => {
    // 15:00 in Bucharest is 13:00Z in November (UTC+2).
    expect(String(estimateDelivery('2026-11-27T12:59:59Z', 'Europe/Bucharest', 3))).toBe('2026-12-03');
    expect(String(estimateDelivery('2026-11-27T13:00:00Z', 'Europe/Bucharest', 3))).toBe('2026-12-04');
  });

  it('reads the order day in the shop zone, not in UTC', () => {
    // 23:30Z on Thursday 26 Nov is already Friday 01:30 in Bucharest.
    expect(String(estimateDelivery('2026-11-26T23:30:00Z', 'Europe/Bucharest', 1))).toBe('2026-11-30');
  });

  it('describes the day for a confirmation email', () => {
    expect(describeDelivery('2026-11-27T10:00:00Z', 'Europe/Bucharest', 3)).toBe('Thursday, December 3rd');
  });
});
