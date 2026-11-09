import { describe, expect, it } from 'vitest';

import { FAILURE_ERROR_CODES } from '@arki/failure';

import { InvalidCoordinates, parseCoordinates as parseCoordinatesCore } from '../../../core/index.js';
import { getMarkerColor } from './colors.js';
import { formatCoordinates, formatCoordinatesWithCardinals, parseCoordinates } from './formatters.js';

describe('maps/google parseCoordinates', () => {
  it('is the core parser, so bad text gives InvalidCoordinates with a reason and not null', () => {
    expect(parseCoordinates).toBe(parseCoordinatesCore);
    const bad = parseCoordinates('12abc, 5');
    expect(InvalidCoordinates.is(bad)).toBe(true);
    expect(parseCoordinates('37.7749, -122.4194')).toEqual({ lat: 37.7749, lng: -122.4194 });
  });
});

const invariantBroken = expect.objectContaining({ code: FAILURE_ERROR_CODES.invariant });

// Why (audit-4 #6): toFixed threw a raw RangeError for a precision outside 0 to 100, undocumented. A precision is
// the caller's constant, so a bad one is the documented invariant failure.
describe('maps/google formatter precision', () => {
  it.each([-1, 101, Number.NaN, Number.POSITIVE_INFINITY])('precision %s throws the invariant failure', precision => {
    const point = { lat: 37.7749, lng: -122.4194 };
    expect(() => formatCoordinates(point, precision)).toThrow(invariantBroken);
    expect(() => formatCoordinatesWithCardinals(point, precision)).toThrow(invariantBroken);
  });

  it('formats within the range', () => {
    expect(formatCoordinates({ lat: 37.7749, lng: -122.4194 })).toBe('37.7749, -122.4194');
    expect(formatCoordinatesWithCardinals({ lat: 37.7749, lng: -122.4194 }, 1)).toBe('37.8°N, 122.4°W');
  });
});

// Why: a negative, fractional or NaN index read past the palette and returned undefined typed as a colour string.
describe('getMarkerColor', () => {
  it('wraps a whole index past the end of the palette', () => {
    expect(getMarkerColor(0)).toBe(getMarkerColor(8));
  });

  it.each([-1, 1.5, Number.NaN])('index %s throws the invariant failure', index => {
    expect(() => getMarkerColor(index)).toThrow(invariantBroken);
  });
});
