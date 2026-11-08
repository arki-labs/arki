import { describe, expect, it } from 'vitest';

import { calculateDestination, calculateMidpoint } from './distance';

// Why: a longitude past 180 is not a valid coordinate; maps, `validateCoordinates` and the geo schemas refuse it,
// so a midpoint or destination across the antimeridian (Fiji, the Bering Strait) broke whatever used it next.
describe('calculateMidpoint (audit-2 noticed)', () => {
  it('returns a longitude within [-180, 180] across the antimeridian', () => {
    const middle = calculateMidpoint({ lat: 0, lng: 179 }, { lat: 0, lng: -177 });
    expect(middle.lat).toBeCloseTo(0, 9);
    expect(middle.lng).toBeCloseTo(-179, 9);
  });

  it('still returns the plain midpoint away from the antimeridian', () => {
    const middle = calculateMidpoint({ lat: 0, lng: 10 }, { lat: 0, lng: 20 });
    expect(middle.lat).toBeCloseTo(0, 9);
    expect(middle.lng).toBeCloseTo(15, 9);
  });
});

describe('calculateDestination', () => {
  it('returns a longitude within [-180, 180] when the path crosses the antimeridian', () => {
    // Due east along the equator, 2 degrees of arc (about 222.39 km) from 179°E lands on 179°W.
    const there = calculateDestination({ lat: 0, lng: 179 }, (2 * Math.PI * 6371) / 180, 90);
    expect(there.lat).toBeCloseTo(0, 6);
    expect(there.lng).toBeCloseTo(-179, 6);
  });
});
