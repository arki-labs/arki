/**
 * The output filter scores and flags with the caller's patterns. A pattern without `g`, or one
 * that matches empty text, must not hang `analyze`, and a non-`g` pattern must count matches, not
 * capture groups.
 */
import { describe, expect, it } from 'vitest';

import { OutputContentFilter } from './output-filter';

describe('OutputContentFilter with caller patterns (F9)', () => {
  it('flags every match of a pattern without the g flag, and ends', () => {
    // WHY: findFlaggedSegments looped forever on `regex.exec` of a non-global regex.
    const filter = new OutputContentFilter({
      categoryPatterns: { violence: [{ pattern: /fight/i, weight: 1, description: 'Fight' }] },
      thresholds: { violence: 0 },
    });

    const result = filter.analyze('fight, fight, fight');

    expect(result.flaggedSegments.map(segment => segment.startIndex)).toEqual([0, 7, 14]);
  });

  it('ends on a pattern that matches empty text', () => {
    const filter = new OutputContentFilter({
      categoryPatterns: { noise: [{ pattern: /z*/g, weight: 1, description: 'Empty match' }] },
      thresholds: { noise: 0 },
    });

    expect(filter.analyze('ab').flaggedSegments.length).toBeGreaterThan(0);
  });

  it('scores a pattern with capture groups by its matches, with or without the g flag', () => {
    const patterns = (pattern: RegExp) =>
      new OutputContentFilter({
        categoryPatterns: { violence: [{ pattern, weight: 0.5, description: 'Fight' }] },
        thresholds: { violence: 1 },
      }).analyze('one fight here').scores.violence;

    expect(patterns(/(f)(i)(g)(h)(t)/)).toBe(patterns(/fight/g));
  });
});
