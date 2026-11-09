import { describe, expect, it } from 'vitest';

import { FAILURE_ERROR_CODES } from '@arki/failure';

import { formatBounds } from './bounds';

import { coordinatesFromUrl, toStandardCoordinates } from './conversions';
import {
  formatCoordinates,
  normalizeCoordinates,
  normalizeLatitude,
  normalizeLongitude,
  parseCoordinates,
  roundCoordinates,
  validateCoordinates,
} from './coordinates';
import { InvalidCoordinates } from './failures';

describe('normalizeLongitude', () => {
  it('wraps any finite longitude into range in constant time, including values near 1e17', () => {
    expect(normalizeLongitude(190)).toBe(-170);
    expect(normalizeLongitude(-190)).toBe(170);
    expect(normalizeLongitude(540)).toBe(180);
    expect(normalizeLongitude(-180)).toBe(-180);
    expect(normalizeLongitude(180)).toBe(180);
    const huge = normalizeLongitude(1e17);
    expect(huge).toBeGreaterThanOrEqual(-180);
    expect(huge).toBeLessThanOrEqual(180);
  });

  it('refuses a longitude that is not finite instead of looping forever', () => {
    expect(InvalidCoordinates.is(normalizeLongitude(Number.POSITIVE_INFINITY))).toBe(true);
    expect(InvalidCoordinates.is(normalizeLongitude(Number.NaN))).toBe(true);
  });
});

describe('normalizeCoordinates', () => {
  it('clamps latitude and wraps longitude', () => {
    expect(normalizeCoordinates({ lat: 100, lng: 200 })).toEqual({ lat: 90, lng: -160 });
  });

  it('returns InvalidCoordinates for a non-finite value', () => {
    expect(InvalidCoordinates.is(normalizeCoordinates({ lat: 0, lng: Number.POSITIVE_INFINITY }))).toBe(true);
    expect(InvalidCoordinates.is(normalizeLatitude(Number.NaN))).toBe(true);
  });
});

describe('parseCoordinates', () => {
  it('reads "lat, lng" in the three accepted shapes', () => {
    expect(parseCoordinates('40.7128, -74.0060')).toEqual({ lat: 40.7128, lng: -74.006 });
    expect(parseCoordinates('40.7128,-74.0060')).toEqual({ lat: 40.7128, lng: -74.006 });
    expect(parseCoordinates('40.7128 -74.0060')).toEqual({ lat: 40.7128, lng: -74.006 });
  });

  it.each(['', 'hello', '12abc, 5', '1e999, 5', '95, 10', '10, 200', '1, 2, 3', '1;2'])(
    'returns InvalidCoordinates for %j instead of throwing',
    (text) => {
      expect(InvalidCoordinates.is(parseCoordinates(text))).toBe(true);
    },
  );
});

describe('coordinatesFromUrl', () => {
  it('reads a "lat,lng" parameter', () => {
    expect(coordinatesFromUrl('40.7128,-74.006')).toEqual({ lat: 40.7128, lng: -74.006 });
  });

  it.each(['', '1e999,5', '95,200', 'a,b', '1'])('returns InvalidCoordinates for %j', (text) => {
    expect(InvalidCoordinates.is(coordinatesFromUrl(text))).toBe(true);
  });
});

describe('toStandardCoordinates', () => {
  it('maps the common shapes', () => {
    expect(toStandardCoordinates({ latitude: 1, longitude: 2 })).toEqual({ lat: 1, lng: 2 });
    expect(toStandardCoordinates({ lat: 1, lon: 2 })).toEqual({ lat: 1, lng: 2 });
  });

  it('returns InvalidCoordinates when a value is missing', () => {
    expect(InvalidCoordinates.is(toStandardCoordinates({ lat: 1 }))).toBe(true);
  });
});

describe('validateCoordinates', () => {
  it('returns the coordinates when valid and InvalidCoordinates otherwise', () => {
    expect(validateCoordinates({ lat: 1, lng: 2 })).toEqual({ lat: 1, lng: 2 });
    expect(InvalidCoordinates.is(validateCoordinates({ lat: 91, lng: 2 }))).toBe(true);
  });
});

// Why (audit-4 #6): toFixed threw a raw RangeError for a precision outside 0 to 100, NaN silently meant 0
// places, and roundCoordinates turned every coordinate into NaN past about 308 places. A precision is the
// caller's constant, so a bad one is the documented invariant failure.
describe('precision', () => {
  const invariantBroken = expect.objectContaining({ code: FAILURE_ERROR_CODES.invariant });
  const point = { lat: 40.712_76, lng: -74.006 };
  const bounds = { north: 1, south: 0, east: 1, west: 0 };

  it.each([-1, 101, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'precision %s throws the invariant failure from formatCoordinates, roundCoordinates and formatBounds',
    precision => {
      expect(() => formatCoordinates(point, precision)).toThrow(invariantBroken);
      expect(() => roundCoordinates(point, precision)).toThrow(invariantBroken);
      expect(() => formatBounds(bounds, precision)).toThrow(invariantBroken);
    },
  );

  it('accepts the whole range 0 to 100', () => {
    expect(formatCoordinates(point, 0)).toBe('41, -74');
    expect(formatCoordinates(point, 100)).toContain('40.712');
    expect(roundCoordinates(point, 2)).toEqual({ lat: 40.71, lng: -74.01 });
    expect(formatBounds(bounds, 1)).toBe('N:1.0 S:0.0 E:1.0 W:0.0');
  });
});
