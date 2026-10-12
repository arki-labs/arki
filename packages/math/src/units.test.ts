import { describe, expect, it } from 'vitest';

import { InvalidArgumentError, RoundingNecessaryError } from './errors.js';
import type { Unit, UnitCategory } from './units.js';
import { convert, convertExact, formatUnit, isUnit, unitCategory, unitsOf } from './units.js';

const CATEGORIES: readonly UnitCategory[] = [
  'length',
  'mass',
  'area',
  'volume',
  'temperature',
  'time',
  'speed',
  'data',
  'energy',
  'pressure',
  'angle',
];

describe('convert', () => {
  it('is the identity for the same unit', () => {
    for (const category of CATEGORIES) {
      for (const unit of unitsOf(category)) expect(convert(12.5, unit, unit)).toBe(12.5);
    }
  });

  it('round-trips every pair in a category within 1e-12 relative', () => {
    for (const category of CATEGORIES) {
      const units = unitsOf(category);
      for (const a of units) {
        for (const b of units) {
          const back = convert(convert(37.5, a, b), b, a);
          expect(Math.abs(back - 37.5) / 37.5).toBeLessThan(1e-12);
        }
      }
    }
  });

  it('gives exact results for the anchors people check by hand', () => {
    expect(convert(1, 'in', 'cm')).toBe(2.54);
    expect(convert(1, 'ft', 'in')).toBe(12);
    expect(convert(1, 'nmi', 'm')).toBe(1852);
    expect(convert(1, 'lb', 'kg')).toBe(0.453_592_37);
    expect(convert(1, 'atm', 'Pa')).toBe(101_325);
    expect(convert(1, 'cal', 'J')).toBe(4.184);
    expect(convert(1, 'kWh', 'J')).toBe(3_600_000);
    expect(convert(1, 'KiB', 'B')).toBe(1024);
    expect(convert(1, 'kB', 'B')).toBe(1000);
    expect(convert(1, 'B', 'bit')).toBe(8);
    expect(convert(1, 'wk', 'h')).toBe(168);
    expect(convert(1, 'ac', 'yd2')).toBe(4840);
    expect(convert(1, 'gal', 'qt')).toBe(4);
    expect(convert(1, 'cup', 'floz')).toBe(8);
  });

  it('handles temperature, including the -40 crossover and absolute zero', () => {
    expect(convert(100, 'C', 'F')).toBe(212);
    expect(convert(-40, 'C', 'F')).toBe(-40);
    expect(convert(-40, 'F', 'C')).toBe(-40);
    expect(convert(0, 'K', 'C')).toBe(-273.15);
    expect(convert(212, 'F', 'C')).toBe(100);
    expect(convert(0, 'C', 'K')).toBe(273.15);
  });

  it('converts angles, using π only where needed', () => {
    expect(convert(180, 'deg', 'rad')).toBe(Math.PI);
    expect(convert(Math.PI, 'rad', 'deg')).toBe(180);
    expect(convert(1, 'turn', 'deg')).toBe(360);
    expect(convert(90, 'deg', 'grad')).toBe(100);
  });

  it('matches known psi and mmHg values', () => {
    expect(convert(1, 'psi', 'Pa')).toBeCloseTo(6894.757_293_168, 9);
    expect(convert(760, 'mmHg', 'Pa')).toBe(101_325);
  });

  it('rejects non-finite values', () => {
    expect(() => convert(Number.NaN, 'm', 'km')).toThrow(InvalidArgumentError);
    expect(() => convert(Infinity, 'm', 'km')).toThrow(InvalidArgumentError);
  });

  it('names both categories on a cross-category conversion', () => {
    expect(() => convert(1, 'm', 'kg')).toThrow(/length.*mass/);
    expect(() => convert(1, 'm', 'kg')).toThrow(InvalidArgumentError);
  });

  it('lists the known side when one unit is unknown', () => {
    const bad = 'furlong' as Unit;
    expect(() => convert(1, 'm', bad)).toThrow(/furlong.*length units are: mm, cm, m/);
    expect(() => convert(1, bad, 'kg')).toThrow(/mass units are/);
    expect(() => convert(1, bad, bad)).toThrow(InvalidArgumentError);
  });
});

describe('convertExact', () => {
  it('returns exact rationals', () => {
    expect(convertExact(1, 'mi', 'km').toString()).toBe('25146/15625');
    expect(convertExact(1, 'in', 'cm').toString()).toBe('127/50');
    expect(convertExact(1, 'gal', 'ml').toString()).toBe('473176473/125000');
  });

  it('is exact for temperature', () => {
    expect(convertExact(1, 'C', 'F').toString()).toBe('169/5');
    expect(convertExact(1, 'C', 'F').toNumber()).toBe(33.8);
    expect(convertExact(0, 'K', 'C').toString()).toBe('-5463/20');
    expect(convertExact('-40', 'F', 'C').toString()).toBe('-40');
  });

  it('keeps decimal inputs exact', () => {
    expect(convertExact('0.1', 'm', 'cm').toString()).toBe('10');
  });

  it('separates SI from IEC data units', () => {
    expect(convertExact(1, 'GB', 'GiB').toString()).toBe('1953125/2097152');
    expect(convertExact(1, 'GiB', 'MiB').toString()).toBe('1024');
    expect(convertExact(1, 'kB', 'KiB').toString()).toBe('125/128');
  });

  it('has exact psi', () => {
    // 0.45359237 × 9.80665 / 0.0254² does not terminate as a decimal; the quoted figure is rounded.
    expect(convertExact(1, 'psi', 'Pa').toString()).toBe('8896443230521/1290320000');
    expect(convertExact(1, 'psi', 'Pa').toNumber()).toBeCloseTo(6894.757_293_168, 9);
  });

  it('is exact among deg, grad and turn but refuses rad', () => {
    expect(convertExact(90, 'deg', 'grad').toString()).toBe('100');
    expect(convertExact(1, 'turn', 'deg').toString()).toBe('360');
    expect(convertExact(3, 'rad', 'rad').toString()).toBe('3');
    expect(() => convertExact(1, 'deg', 'rad')).toThrow(RoundingNecessaryError);
    expect(() => convertExact(1, 'rad', 'turn')).toThrow(RoundingNecessaryError);
  });

  it('rejects cross-category conversions', () => {
    expect(() => convertExact(1, 's', 'Pa')).toThrow(/time.*pressure/);
  });
});

describe('unit registry', () => {
  it('lists units per category', () => {
    expect(unitsOf('length')).toEqual(['mm', 'cm', 'm', 'km', 'in', 'ft', 'yd', 'mi', 'nmi']);
    expect(unitsOf('temperature')).toEqual(['C', 'F', 'K']);
    expect(unitsOf('angle')).toEqual(['deg', 'rad', 'grad', 'turn']);
  });

  it('maps every listed unit back to its category', () => {
    for (const category of CATEGORIES) {
      for (const unit of unitsOf(category)) expect(unitCategory(unit)).toBe(category);
    }
  });

  it('recognises unit symbols', () => {
    expect(isUnit('km')).toBe(true);
    expect(isUnit('m/s')).toBe(true);
    expect(isUnit('KB')).toBe(false);
    expect(isUnit('°C')).toBe(false);
    expect(isUnit('toString')).toBe(false);
  });
});

describe('formatUnit', () => {
  it('uses Intl for known units', () => {
    expect(formatUnit(5, 'km', { locale: 'en' })).toBe('5 km');
    expect(formatUnit(5, 'km', { locale: 'en', display: 'long' })).toBe('5 kilometers');
    expect(formatUnit(1, 'km', { locale: 'en', display: 'long' })).toBe('1 kilometer');
    expect(formatUnit(1.234_56, 'kg', { locale: 'en', maximumFractionDigits: 1 })).toBe('1.2 kg');
  });

  it('falls back to number plus symbol for units Intl does not name', () => {
    expect(formatUnit(30, 'psi', { locale: 'en' })).toBe('30 psi');
    expect(formatUnit(1.5, 'rad', { locale: 'en' })).toBe('1.5 rad');
    expect(formatUnit(300, 'K', { locale: 'en', display: 'long' })).toBe('300 K');
  });
});

describe('review regressions', () => {
  it('temperature conversion does not overflow near the double limit', () => {
    expect(Math.abs(convert(1e308, 'F', 'C') / 5.555_555_555_555_556e307 - 1)).toBeLessThan(1e-14);
    expect(Number.isFinite(convert(1e308, 'F', 'C'))).toBe(true);
    expect(Math.abs(convert(8e307, 'C', 'F') / 1.44e308 - 1)).toBeLessThan(1e-14);
    expect(Number.isFinite(convert(8e307, 'C', 'F'))).toBe(true);
  });
  it('keeps exact temperature anchors', () => {
    expect(convert(100, 'C', 'F')).toBe(212);
    expect(convert(-40, 'F', 'C')).toBe(-40);
    expect(convert(212, 'F', 'C')).toBe(100);
    expect(convert(32, 'F', 'C')).toBe(0);
    expect(convert(0, 'C', 'F')).toBe(32);
  });
  it('formatUnit gives the same result across cached calls and many keys', () => {
    expect(formatUnit(5, 'km')).toBe(formatUnit(5, 'km'));
    for (let i = 0; i < 300; i++) formatUnit(1, 'km', { maximumFractionDigits: i % 20, locale: i % 2 ? 'en' : 'de' });
    expect(formatUnit(5, 'km', { display: 'long' })).toBe('5 kilometers');
  });
  it('convertExact accepts its own output', () => {
    expect(convertExact(convertExact(1, 'mi', 'km'), 'km', 'mi').toString()).toBe('1');
  });
});
