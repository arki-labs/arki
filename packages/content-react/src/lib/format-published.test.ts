import { describe, expect, it } from 'vitest';

import { formatPublished } from './format-published';

describe('formatPublished', () => {
  it('formats a valid date', () => {
    expect(formatPublished(new Date('2026-10-05T12:00:00Z'), 'LLL dd, y')).toBe('Oct 05, 2026');
  });

  it('shows the value as written for an invalid date instead of throwing a RangeError', () => {
    expect(formatPublished('not a date', 'LLL dd, y')).toBe('not a date');
    expect(() => formatPublished(new Date(Number.NaN), 'LLL dd, y')).not.toThrow();
  });
});
