/**
 * Analytics come back from storage as outside data: `import` must check them and refuse malformed
 * data with InvalidInput, leaving the collector as it was.
 */
import { describe, expect, it } from 'vitest';

import { InvalidInput } from '@arki/failure';

import { SearchAnalyticsCollector } from './analytics';

function collectorWithOneSearch() {
  const collector = new SearchAnalyticsCollector();
  collector.record({
    query: 'alpha',
    mode: 'semantic',
    resultCount: 2,
    responseTime: 12,
    timestamp: new Date('2026-10-30T10:00:00Z'),
  });
  return collector;
}

describe('SearchAnalyticsCollector.import (F23)', () => {
  it('restores an export that went through JSON, timestamps included', () => {
    // A real JSON round trip, as storage does: timestamps come back as strings (structuredClone would keep Dates).
    // eslint-disable-next-line unicorn/prefer-structured-clone
    const stored: unknown = JSON.parse(JSON.stringify(collectorWithOneSearch().export()));
    const restored = new SearchAnalyticsCollector();

    expect(restored.import(stored)).toBeUndefined();
    expect(restored.getQueryFrequency('alpha')).toEqual({
      count: 1,
      firstSeen: new Date('2026-10-30T10:00:00Z'),
      lastSeen: new Date('2026-10-30T10:00:00Z'),
    });
    expect(restored.getMetrics().popularQueries).toEqual(['alpha']);
  });

  it('returns InvalidInput for malformed popularSearches and keeps its current data', () => {
    // WHY: `new Map(popularSearches)` threw TypeError on an entry that was not a pair.
    const collector = collectorWithOneSearch();
    const before = collector.export();

    const result = collector.import({ ...before, popularSearches: [42] });

    expect(InvalidInput.is(result) && result.code).toBe('schema.invalid_input');
    expect(collector.getMetrics().totalSearches).toBe(1);
  });

  it('returns InvalidInput for a history entry with a timestamp that is not a date', () => {
    const collector = new SearchAnalyticsCollector();

    const result = collector.import({
      history: [{ query: 'a', mode: 'semantic', resultCount: 1, responseTime: 1, timestamp: 'yesterday' }],
      popularSearches: [],
      cacheHits: 0,
      totalRequests: 0,
    });

    expect(InvalidInput.is(result)).toBe(true);
  });
});
