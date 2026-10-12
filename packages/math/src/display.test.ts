import { describe, expect, it } from 'vitest';

import { decimal } from './decimal.js';
import { InvalidArgumentError, ResourceLimitError, RoundingNecessaryError } from './errors.js';
import { num } from './fluent.js';
import { ratio } from './rational.js';

// Node's `util.inspect` and Deno's console both look these symbols up on the object.
const NODE_INSPECT = Symbol.for('nodejs.util.inspect.custom');
const DENO_INSPECT = Symbol.for('Deno.customInspect');

function inspectWith(value: object, hook: symbol): unknown {
  return Reflect.apply(Reflect.get(value, hook) as () => string, value, []);
}

describe('console display', () => {
  it('prints exact values as their own kind instead of a bigint dump', () => {
    expect(inspectWith(decimal('1.50'), NODE_INSPECT)).toBe('Decimal(1.50)');
    expect(inspectWith(ratio('4 1/2'), NODE_INSPECT)).toBe('Rational(9/2)');
    expect(inspectWith(num(3), NODE_INSPECT)).toBe('NumberValue(3)');
  });

  it('exposes the same text under the Deno hook', () => {
    expect(inspectWith(decimal('-2'), DENO_INSPECT)).toBe('Decimal(-2)');
    expect(inspectWith(ratio(1, 3), DENO_INSPECT)).toBe('Rational(1/3)');
    expect(inspectWith(num(-1.5), DENO_INSPECT)).toBe('NumberValue(-1.5)');
  });
});

describe('Decimal#roundTo', () => {
  it('rounds to a step, half-up by default', () => {
    expect(decimal('1.23').roundTo('0.05').toString()).toBe('1.25');
    expect(decimal('1.22').roundTo('0.05').toString()).toBe('1.20');
    expect(decimal('17').roundTo(5).toString()).toBe('15');
    expect(decimal('-1.23').roundTo('0.05', 'floor').toString()).toBe('-1.25');
  });

  it('refuses a zero or negative step', () => {
    expect(() => decimal('1').roundTo(0)).toThrow(InvalidArgumentError);
    expect(() => decimal('1').roundTo('-0.5')).toThrow(InvalidArgumentError);
  });

  it('honours the unnecessary mode', () => {
    expect(decimal('1.25').roundTo('0.25', 'unnecessary').toString()).toBe('1.25');
    expect(() => decimal('1.23').roundTo('0.25', 'unnecessary')).toThrow(RoundingNecessaryError);
  });
});

describe('mixed-number parsing', () => {
  it('reads "whole numerator/denominator" with the sign on the whole part', () => {
    expect(ratio('4 1/2').toString()).toBe('9/2');
    expect(ratio('-4 1/2').toString()).toBe('-9/2');
    expect(ratio('+1 3 / 4').toString()).toBe('7/4');
    expect(ratio('0 2/4').toString()).toBe('1/2');
  });

  it('round-trips through toMixed', () => {
    const mixed = ratio('-7 3/8').toMixed();
    expect(mixed.whole).toBe(-7n);
    expect(mixed.fraction.toString()).toBe('-3/8');
  });

  it('still rejects malformed text', () => {
    expect(() => ratio('4 1/')).toThrow();
    expect(() => ratio('4 1 2')).toThrow();
    expect(() => ratio('1 1/0')).toThrow();
  });

  it('applies the digit limit to every part, not only the denominator', () => {
    expect(() => ratio(`${'1'.repeat(10_001)} 1/2`)).toThrow(ResourceLimitError);
    expect(() => ratio(`1 ${'1'.repeat(10_001)}/2`)).toThrow(ResourceLimitError);
  });
});
