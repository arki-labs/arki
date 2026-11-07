import { describe, expect, it } from 'vitest';

import { InvalidCoordinates, parseCoordinates as parseCoordinatesCore } from '../../../core/index.js';
import { parseCoordinates } from './formatters.js';

describe('maps/google parseCoordinates', () => {
  it('is the core parser, so bad text gives InvalidCoordinates with a reason and not null', () => {
    expect(parseCoordinates).toBe(parseCoordinatesCore);
    const bad = parseCoordinates('12abc, 5');
    expect(InvalidCoordinates.is(bad)).toBe(true);
    expect(parseCoordinates('37.7749, -122.4194')).toEqual({ lat: 37.7749, lng: -122.4194 });
  });
});
