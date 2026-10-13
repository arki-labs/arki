import { describe, expect, it } from 'vitest';

import type { Unit, UnitCategory } from './units.js';
import { InvalidArgumentError, RoundingNecessaryError } from './errors.js';
import { ratio } from './rational.js';
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
  'power',
  'frequency',
  'force',
  'torque',
  'fuelEconomy',
  'dataRate',
  'solidAngle',
  'electricCurrent',
  'illuminance',
  'radioactivity',
  'dynamicViscosity',
  'kinematicViscosity',
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
    expect(() => convert(1, 'm', bad)).toThrow(/furlong.*length units are: nm, µm, mm, cm, m/);
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
    expect(unitsOf('length')).toEqual(['nm', 'µm', 'mm', 'cm', 'm', 'km', 'in', 'ft', 'yd', 'mi', 'nmi', 'au', 'ly']);
    expect(unitsOf('temperature')).toEqual(['C', 'F', 'K']);
    expect(unitsOf('angle')).toEqual(['deg', 'rad', 'grad', 'turn', 'arcmin', 'arcsec']);
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

describe('power, frequency, force, torque and data rate', () => {
  it('defines mechanical horsepower as 550 ft·lbf/s and metric horsepower as 75 kgf·m/s', () => {
    expect(convert(1, 'hp', 'W')).toBe(745.699_871_582_270_2);
    expect(convertExact(1, 'hp', 'W').eq('745.69987158227022')).toBe(true);
    expect(convertExact(1, 'hp_metric', 'W').eq('735.49875')).toBe(true);
    expect(convert(1, 'hp_metric', 'W')).toBe(735.498_75);
    expect(convert(1, 'hp', 'hp_metric')).toBeCloseTo(1.013_869_665, 9);
  });

  it('converts BTU/h through the International Table BTU', () => {
    expect(convert(1, 'kW', 'BTU/h')).toBeCloseTo(3412.141_633, 5);
    expect(convertExact(3600, 'BTU/h', 'W').eq('1055.05585262')).toBe(true);
  });

  it('keeps SI prefixes exact and rpm as 1/60 Hz', () => {
    expect(convert(1, 'GHz', 'MHz')).toBe(1000);
    expect(convert(120, 'rpm', 'Hz')).toBe(2);
    expect(convertExact(1, 'rpm', 'Hz').eq(ratio(1, 60))).toBe(true);
  });

  it('derives pound-force and kilogram-force from standard gravity', () => {
    expect(convert(1, 'kgf', 'N')).toBe(9.806_65);
    expect(convert(1, 'lbf', 'N')).toBeCloseTo(4.448_221_615, 9);
    expect(convert(1, 'N', 'dyn')).toBe(100_000);
    expect(convert(1, 'kN', 'N')).toBe(1000);
  });

  it('builds torque from force times length', () => {
    expect(convert(1, 'kgf*m', 'N*m')).toBe(9.806_65);
    expect(convert(1, 'lbf*ft', 'N*m')).toBeCloseTo(1.355_817_948, 9);
  });

  it('separates bits from bytes and decimal from binary in data rates', () => {
    expect(convert(1, 'B/s', 'bit/s')).toBe(8);
    expect(convert(100, 'Mbit/s', 'MB/s')).toBe(12.5);
    expect(convert(1, 'MiB/s', 'B/s')).toBe(1_048_576);
    expect(convert(1, 'Gbit/s', 'Mbit/s')).toBe(1000);
  });

  it('formats units Intl cannot name with readable symbols', () => {
    expect(formatUnit(100, 'hp_metric', { locale: 'en' })).toBe('100 PS');
    expect(formatUnit(50, 'N*m', { locale: 'en' })).toBe('50 N·m');
    expect(formatUnit(60, 'kW', { locale: 'en' })).toBe('60 kW');
  });
});

describe('fuel economy', () => {
  it('treats l/100km as the reciprocal of km/l, not a scale factor', () => {
    expect(convert(10, 'km/l', 'l/100km')).toBe(10);
    expect(convert(5, 'km/l', 'l/100km')).toBe(20);
    expect(convert(20, 'l/100km', 'km/l')).toBe(5);
    // Doubling the economy halves the consumption: a linear factor could not do this.
    expect(convert(40, 'mpg', 'l/100km')).toBeCloseTo(convert(20, 'mpg', 'l/100km') / 2, 12);
  });

  it('round-trips through the reciprocal', () => {
    for (const unit of ['km/l', 'mpg', 'mpg_imp'] as const) {
      expect(convert(convert(7.4, 'l/100km', unit), unit, 'l/100km')).toBeCloseTo(7.4, 12);
    }
  });

  it('knows an imperial gallon is bigger than a US one, so mpg_imp is a bigger number for the same car', () => {
    expect(convert(30, 'mpg', 'l/100km')).toBeCloseTo(7.840_486, 5);
    expect(convert(30, 'mpg_imp', 'l/100km')).toBeCloseTo(9.416_031, 5);
    expect(convert(1, 'mpg_imp', 'mpg')).toBeCloseTo(0.832_674_185, 9);
  });

  it('stays exact through the reciprocal', () => {
    expect(convertExact(10, 'l/100km', 'km/l').eq(10)).toBe(true);
    expect(convertExact(4, 'km/l', 'l/100km').eq(25)).toBe(true);
    const back = convertExact(convertExact(7, 'l/100km', 'mpg'), 'mpg', 'l/100km');
    expect(back.eq(7)).toBe(true);
  });

  it('refuses zero, whose reciprocal is infinite', () => {
    expect(() => convert(0, 'l/100km', 'mpg')).toThrow(InvalidArgumentError);
    expect(() => convert(0, 'mpg', 'l/100km')).toThrow(InvalidArgumentError);
    expect(() => convertExact(0, 'l/100km', 'km/l')).toThrow(InvalidArgumentError);
    expect(() => convertExact(0, 'km/l', 'l/100km')).toThrow(InvalidArgumentError);
    expect(convert(0, 'mpg', 'km/l')).toBe(0);
  });
});

describe('units added to existing categories', () => {
  it('uses exact definitions for astronomy and SI 2019', () => {
    // IAU 2012 fixed the astronomical unit; the IAU light year is c × one Julian year.
    expect(convertExact(1, 'au', 'm').eq(ratio('149597870700'))).toBe(true);
    expect(convertExact(1, 'ly', 'm').eq(ratio('9460730472580800'))).toBe(true);
    expect(convertExact(1, 'ly', 'au').eq(ratio('94607304725808/1495978707'))).toBe(true);
    // The eV is exact since SI 2019 fixed the elementary charge.
    expect(convertExact(1, 'eV', 'J').eq(ratio(1_602_176_634, 10n ** 28n))).toBe(true);
    expect(convertExact(1, 'nm', 'µm').eq(ratio('1/1000'))).toBe(true);
  });

  it('defines month and year as the Julian year, 365.25 days', () => {
    expect(convertExact(1, 'year', 'd').eq(ratio('1461/4'))).toBe(true);
    expect(convertExact(12, 'month', 'year').eq(ratio('1'))).toBe(true);
    expect(convertExact(1, 'month', 'd').eq(ratio('487/16'))).toBe(true);
  });

  it('derives cubic and imperial volumes from the inch and the 1985 gallon', () => {
    expect(convertExact(1, 'ft3', 'in3').eq(ratio('1728'))).toBe(true);
    expect(convertExact(1, 'yd3', 'ft3').eq(ratio('27'))).toBe(true);
    expect(convertExact(1, 'm3', 'cm3').eq(ratio('1000000'))).toBe(true);
    expect(convertExact(1, 'gal_imp', 'l').eq(ratio('454609/100000'))).toBe(true);
    expect(convertExact(1, 'gal_imp', 'qt_imp').eq(ratio('4'))).toBe(true);
    expect(convertExact(1, 'qt_imp', 'pt_imp').eq(ratio('2'))).toBe(true);
    expect(convertExact(1, 'pt_imp', 'floz_imp').eq(ratio('20'))).toBe(true);
    expect(convertExact(1, 'gal', 'in3').eq(ratio('231'))).toBe(true);
  });

  it('keeps US and imperial pints apart', () => {
    expect(convert(1, 'pt_imp', 'pt')).toBeCloseTo(1.200_949_9, 6);
  });

  it('adds speed, energy, pressure, angle and bit units with exact ratios', () => {
    expect(convertExact(1, 'ft/s', 'm/s').eq(ratio('381/1250'))).toBe(true);
    expect(convertExact(1, 'MJ', 'kJ').eq(ratio('1000'))).toBe(true);
    expect(convertExact(1, 'BTU', 'J').eq(ratio('105505585262/100000000'))).toBe(true);
    expect(convertExact(1, 'MPa', 'kPa').eq(ratio('1000'))).toBe(true);
    expect(convertExact(760, 'Torr', 'Pa').eq(ratio('101325'))).toBe(true);
    expect(convertExact(1, 'deg', 'arcmin').eq(ratio('60'))).toBe(true);
    expect(convertExact(1, 'arcmin', 'arcsec').eq(ratio('60'))).toBe(true);
    expect(convertExact(1, 'turn', 'arcsec').eq(ratio('1296000'))).toBe(true);
    expect(convertExact(1, 'Mbit', 'kbit').eq(ratio('1000'))).toBe(true);
    expect(convertExact(1, 'Kibit', 'bit').eq(ratio('1024'))).toBe(true);
    expect(convertExact(1, 'Gbit', 'B').eq(ratio('125000000'))).toBe(true);
  });

  it('still needs π for rad and arc units', () => {
    expect(convert(1, 'arcsec', 'rad')).toBeCloseTo(4.848_136_811e-6, 14);
    expect(() => convertExact(1, 'arcmin', 'rad')).toThrow(RoundingNecessaryError);
  });
});

describe('new categories', () => {
  it('converts electric current by SI prefixes', () => {
    expect(convertExact(1, 'kA', 'mA').eq(ratio('1000000'))).toBe(true);
    expect(convertExact(1, 'A', 'µA').eq(ratio('1000000'))).toBe(true);
  });

  it('defines the foot-candle as one lumen per square foot', () => {
    // 1 / 0.3048² = 10.7639104167…, kept as a rational
    expect(convertExact(1, 'fc', 'lx').eq(ratio('1562500/145161'))).toBe(true);
    expect(convert(1, 'fc', 'lx')).toBeCloseTo(10.763_910_416_7, 9);
  });

  it('defines the curie as exactly 3.7e10 becquerel', () => {
    expect(convertExact(1, 'Ci', 'Bq').eq(ratio('37000000000'))).toBe(true);
    expect(convertExact(1, 'mCi', 'MBq').eq(ratio('37'))).toBe(true);
    expect(convertExact(1, 'µCi', 'kBq').eq(ratio('37'))).toBe(true);
  });

  it('keeps dynamic and kinematic viscosity as two quantities', () => {
    expect(convertExact(1, 'P', 'Pa*s').eq(ratio('1/10'))).toBe(true);
    expect(convertExact(1, 'cP', 'mPa*s').eq(ratio('1'))).toBe(true);
    expect(convertExact(1, 'St', 'cSt').eq(ratio('100'))).toBe(true);
    expect(convertExact(1, 'cSt', 'm2/s').eq(ratio('1/1000000'))).toBe(true);
    expect(() => convert(1, 'cP', 'cSt')).toThrow(/dynamicViscosity.*kinematicViscosity/);
  });

  it('treats solid angle like angle: deg2 is (π/180)² sr', () => {
    expect(convert(1, 'deg2', 'sr')).toBeCloseTo((Math.PI / 180) ** 2, 15);
    expect(convert(1, 'sr', 'deg2')).toBeCloseTo((180 / Math.PI) ** 2, 8);
    // the whole sphere is 4π sr ≈ 41253 square degrees
    expect(convert(4 * Math.PI, 'sr', 'deg2')).toBeCloseTo(41_252.96, 1);
    expect(() => convertExact(1, 'sr', 'deg2')).toThrow(RoundingNecessaryError);
    expect(convertExact(3, 'deg2', 'deg2').eq(ratio('3'))).toBe(true);
  });

  it('registers the units under their categories', () => {
    expect(unitCategory('µCi')).toBe('radioactivity');
    expect(unitCategory('fc')).toBe('illuminance');
    expect(unitCategory('St')).toBe('kinematicViscosity');
    expect(unitCategory('deg2')).toBe('solidAngle');
    expect(isUnit('µA')).toBe(true);
  });

  it('formats the new symbols readably', () => {
    expect(formatUnit(2, 'Pa*s')).toBe('2 Pa·s');
    expect(formatUnit(2, 'deg2')).toBe('2 deg²');
    expect(formatUnit(3, 'gal_imp')).toBe('3 gal (imp)');
    expect(formatUnit(3, 'A')).toBe('3 A');
  });
});
