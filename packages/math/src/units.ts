/**
 * Unit conversion across twenty-two categories: length, mass, area, volume,
 * temperature, time, speed, data, energy, pressure, angle, solid angle, power,
 * frequency, force, torque, fuel economy, data rate, electric current,
 * illuminance, radioactivity, dynamic viscosity and kinematic viscosity.
 *
 * Every factor is stored as an exact `Rational` (`1 in = 0.0254 m`,
 * `1 lb = 0.45359237 kg`, ...). `convert` rounds each pair's factor to a double
 * once, correctly, so `convert(1, 'in', 'cm') === 2.54`. `convertExact` keeps
 * the rational and never rounds.
 *
 * `pc` is the IAU 2015 parsec, 648000/π au: it involves π, so like `rad` it converts
 * with `convert` and makes `convertExact` throw. `fathom` is 6 ft, `ct` the metric
 * carat (0.2 g), `ton_us` the short ton (2000 lb) and `ton_uk` the long ton (2240 lb).
 * `kcal/h` uses the thermochemical kilocalorie, like `kcal`; `ft*lbf` is foot-pound-force.
 *
 * Unit symbols are the public identifiers and are case sensitive. Temperature
 * uses plain `'C' | 'F' | 'K'` (no `'°C'` aliases), area and volume powers are
 * written `m2`, `m3`. Volumes beyond `l`, `ml`, `cl`, `m3` are US customary.
 * Pounds, ounces and stones are avoirdupois. `cal` is the thermochemical
 * calorie (4.184 J). `kB`, `MB`, ... are decimal; `KiB`, `MiB`, ... are binary.
 *
 * `hp` is the mechanical (imperial) horsepower and `hp_metric` the metric one
 * (PS). `mpg` is the US miles per US gallon, `mpg_imp` miles per imperial gallon.
 * Fuel economy is the one reciprocal category: `l/100km` is litres per distance,
 * so it converts to the others by `100 / x`, and zero has no counterpart.
 *
 * `µ` is the micro sign U+00B5 (`µm`, `µA`, `µCi`). `month` and `year` follow the
 * convention of most unit converters: the Julian year of 365.25 days (31 557 600 s)
 * and a month of one twelfth of it (30.4375 days); calendar months and years vary,
 * so use a date library for those. `au` is the IAU 2012 value, `ly` the light year
 * of one Julian year at c. `gal_imp`, `qt_imp`, `pt_imp`, `floz_imp` are imperial;
 * `Torr` is 101325/760 Pa. `fc` (foot-candle) is one lumen per square foot, `Ci`
 * (curie) is 3.7e10 Bq. Dynamic viscosity (`Pa*s`, `P`) and kinematic viscosity
 * (`m2/s`, `St`) are different quantities and separate categories.
 *
 * Every numeric input must be finite; `NaN` and `±Infinity` throw.
 */

import type { RationalInput } from './rational.js';
import type { RoundingMode } from './rounding.js';
import { InvalidArgumentError, RoundingNecessaryError } from './errors.js';
import { ratio } from './internal/exact.js';
import { assertFinite } from './number.js';
import { Rational } from './rational.js';

export type LengthUnit =
  'nm' | 'µm' | 'mm' | 'cm' | 'dm' | 'm' | 'km' | 'in' | 'ft' | 'yd' | 'fathom' | 'mi' | 'nmi' | 'au' | 'ly' | 'pc';
export type MassUnit = 'mg' | 'ct' | 'g' | 'kg' | 't' | 'oz' | 'lb' | 'st' | 'ton_us' | 'ton_uk';
export type AreaUnit = 'mm2' | 'cm2' | 'm2' | 'ha' | 'km2' | 'in2' | 'ft2' | 'yd2' | 'ac' | 'mi2';
export type VolumeUnit =
  | 'ml'
  | 'cl'
  | 'l'
  | 'cm3'
  | 'm3'
  | 'in3'
  | 'ft3'
  | 'yd3'
  | 'tsp'
  | 'tbsp'
  | 'floz'
  | 'cup'
  | 'pt'
  | 'qt'
  | 'gal'
  | 'floz_imp'
  | 'pt_imp'
  | 'qt_imp'
  | 'gal_imp';
export type TemperatureUnit = 'C' | 'F' | 'K';
export type TimeUnit = 'ms' | 's' | 'min' | 'h' | 'd' | 'wk' | 'month' | 'year';
export type SpeedUnit = 'm/s' | 'km/h' | 'mph' | 'kn' | 'ft/s';
export type DataUnit =
  | 'B'
  | 'kB'
  | 'MB'
  | 'GB'
  | 'TB'
  | 'PB'
  | 'EB'
  | 'KiB'
  | 'MiB'
  | 'GiB'
  | 'TiB'
  | 'PiB'
  | 'EiB'
  | 'bit'
  | 'kbit'
  | 'Mbit'
  | 'Gbit'
  | 'Kibit'
  | 'Mibit'
  | 'Gibit';
export type EnergyUnit = 'J' | 'kJ' | 'cal' | 'kcal' | 'Wh' | 'kWh' | 'MJ' | 'GJ' | 'BTU' | 'eV' | 'ft*lbf';
export type PressureUnit = 'Pa' | 'kPa' | 'MPa' | 'bar' | 'atm' | 'psi' | 'mmHg' | 'Torr';
export type AngleUnit = 'deg' | 'rad' | 'grad' | 'turn' | 'arcmin' | 'arcsec';
export type SolidAngleUnit = 'sr' | 'deg2';
export type PowerUnit = 'W' | 'kW' | 'MW' | 'hp' | 'hp_metric' | 'BTU/h' | 'kcal/h';
export type FrequencyUnit = 'Hz' | 'kHz' | 'MHz' | 'GHz' | 'rpm';
export type ForceUnit = 'N' | 'kN' | 'lbf' | 'kgf' | 'dyn';
export type TorqueUnit = 'N*m' | 'lbf*ft' | 'kgf*m';
export type FuelEconomyUnit = 'km/l' | 'l/100km' | 'mpg' | 'mpg_imp';
export type DataRateUnit = 'bit/s' | 'kbit/s' | 'Mbit/s' | 'Gbit/s' | 'B/s' | 'kB/s' | 'MB/s' | 'GB/s' | 'MiB/s';
export type ElectricCurrentUnit = 'µA' | 'mA' | 'A' | 'kA';
export type IlluminanceUnit = 'lx' | 'fc';
export type RadioactivityUnit = 'Bq' | 'kBq' | 'MBq' | 'µCi' | 'mCi' | 'Ci';
export type DynamicViscosityUnit = 'Pa*s' | 'mPa*s' | 'P' | 'cP';
export type KinematicViscosityUnit = 'm2/s' | 'cSt' | 'St';

export type UnitCategory =
  | 'length'
  | 'mass'
  | 'area'
  | 'volume'
  | 'temperature'
  | 'time'
  | 'speed'
  | 'data'
  | 'energy'
  | 'pressure'
  | 'angle'
  | 'solidAngle'
  | 'power'
  | 'frequency'
  | 'force'
  | 'torque'
  | 'fuelEconomy'
  | 'dataRate'
  | 'electricCurrent'
  | 'illuminance'
  | 'radioactivity'
  | 'dynamicViscosity'
  | 'kinematicViscosity';

/** Every supported unit symbol. */
export type Unit =
  | LengthUnit
  | MassUnit
  | AreaUnit
  | VolumeUnit
  | TemperatureUnit
  | TimeUnit
  | SpeedUnit
  | DataUnit
  | EnergyUnit
  | PressureUnit
  | AngleUnit
  | SolidAngleUnit
  | PowerUnit
  | FrequencyUnit
  | ForceUnit
  | TorqueUnit
  | FuelEconomyUnit
  | DataRateUnit
  | ElectricCurrentUnit
  | IlluminanceUnit
  | RadioactivityUnit
  | DynamicViscosityUnit
  | KinematicViscosityUnit;

export type FormatUnitOptions = {
  /** BCP 47 locale; defaults to the runtime's. */
  locale?: string;
  /** `'short'` (default) → `5 km`, `'long'` → `5 kilometers`, `'narrow'` → `5km`. */
  display?: 'short' | 'long' | 'narrow';
  maximumFractionDigits?: number;
};

const UNITS_BY_CATEGORY: Record<UnitCategory, readonly Unit[]> = {
  length: ['nm', 'µm', 'mm', 'cm', 'dm', 'm', 'km', 'in', 'ft', 'yd', 'fathom', 'mi', 'nmi', 'au', 'ly', 'pc'],
  mass: ['mg', 'ct', 'g', 'kg', 't', 'oz', 'lb', 'st', 'ton_us', 'ton_uk'],
  area: ['mm2', 'cm2', 'm2', 'ha', 'km2', 'in2', 'ft2', 'yd2', 'ac', 'mi2'],
  volume: [
    'ml',
    'cl',
    'l',
    'cm3',
    'm3',
    'in3',
    'ft3',
    'yd3',
    'tsp',
    'tbsp',
    'floz',
    'cup',
    'pt',
    'qt',
    'gal',
    'floz_imp',
    'pt_imp',
    'qt_imp',
    'gal_imp',
  ],
  temperature: ['C', 'F', 'K'],
  time: ['ms', 's', 'min', 'h', 'd', 'wk', 'month', 'year'],
  speed: ['m/s', 'km/h', 'mph', 'kn', 'ft/s'],
  data: [
    'B',
    'kB',
    'MB',
    'GB',
    'TB',
    'PB',
    'EB',
    'KiB',
    'MiB',
    'GiB',
    'TiB',
    'PiB',
    'EiB',
    'bit',
    'kbit',
    'Mbit',
    'Gbit',
    'Kibit',
    'Mibit',
    'Gibit',
  ],
  energy: ['J', 'kJ', 'cal', 'kcal', 'Wh', 'kWh', 'MJ', 'GJ', 'BTU', 'eV', 'ft*lbf'],
  pressure: ['Pa', 'kPa', 'MPa', 'bar', 'atm', 'psi', 'mmHg', 'Torr'],
  angle: ['deg', 'rad', 'grad', 'turn', 'arcmin', 'arcsec'],
  solidAngle: ['sr', 'deg2'],
  power: ['W', 'kW', 'MW', 'hp', 'hp_metric', 'BTU/h', 'kcal/h'],
  frequency: ['Hz', 'kHz', 'MHz', 'GHz', 'rpm'],
  force: ['N', 'kN', 'lbf', 'kgf', 'dyn'],
  torque: ['N*m', 'lbf*ft', 'kgf*m'],
  fuelEconomy: ['km/l', 'l/100km', 'mpg', 'mpg_imp'],
  dataRate: ['bit/s', 'kbit/s', 'Mbit/s', 'Gbit/s', 'B/s', 'kB/s', 'MB/s', 'GB/s', 'MiB/s'],
  electricCurrent: ['µA', 'mA', 'A', 'kA'],
  illuminance: ['lx', 'fc'],
  radioactivity: ['Bq', 'kBq', 'MBq', 'µCi', 'mCi', 'Ci'],
  dynamicViscosity: ['Pa*s', 'mPa*s', 'P', 'cP'],
  kinematicViscosity: ['m2/s', 'cSt', 'St'],
};

const CATEGORY_OF: ReadonlyMap<string, UnitCategory> = new Map(
  Object.entries(UNITS_BY_CATEGORY).flatMap(([category, units]) =>
    units.map((unit): [string, UnitCategory] => [unit, category as UnitCategory]),
  ),
);

/**
 * A unit's size in its category's base unit: `r * π^pi`. Only angles (`pi: 1`), solid angles (`pi: 2`)
 * and the parsec (`pi: -1`, it is 648000/π au) use π.
 */
type Factor = { readonly r: Rational; readonly pi: -1 | 0 | 1 | 2 };

const lin = (r: Rational): Factor => ({ r, pi: 0 });

// Exact definitions -----------------------------------------------------------

const M_PER_IN = ratio('0.0254'); // international inch, 1959
const KG_PER_LB = ratio('0.45359237'); // international avoirdupois pound, 1959
const G_STANDARD = ratio('9.80665'); // standard gravity, m/s², exact by definition (CGPM 1901)
const M_PER_FT = M_PER_IN.times(12);
const M_PER_YD = M_PER_FT.times(3);
const M_PER_MI = M_PER_YD.times(1760);
const M_PER_NMI = ratio(1852); // international nautical mile
const L_PER_IN3 = M_PER_IN.pow(3).times(1000); // 1 l = 1 dm³ = 0.001 m³
const L_PER_GAL = L_PER_IN3.times(231); // US liquid gallon = 231 in³
const L_PER_QT = L_PER_GAL.dividedBy(4);
const L_PER_PT = L_PER_QT.dividedBy(2);
const L_PER_CUP = L_PER_PT.dividedBy(2);
const L_PER_FLOZ = L_PER_CUP.dividedBy(8);
const L_PER_TBSP = L_PER_FLOZ.dividedBy(2);
const L_PER_TSP = L_PER_TBSP.dividedBy(3);
const PA_PER_ATM = ratio(101_325); // standard atmosphere, exact by definition
const SECONDS_PER_HOUR = ratio(3600);
const N_PER_LBF = KG_PER_LB.times(G_STANDARD); // pound-force = 1 lb × standard gravity
const N_PER_KGF = G_STANDARD; // kilogram-force = 1 kg × standard gravity
const L_PER_GAL_IMP = ratio('4.54609'); // imperial gallon, exact by the UK Weights and Measures Act 1985
const J_PER_BTU = ratio('1055.05585262'); // International Table BTU (IT, 1956 Steam Tables conference)
const M_PER_AU = ratio('149597870700'); // astronomical unit, IAU 2012 Resolution B2, exact
const SECONDS_PER_JULIAN_YEAR = ratio(86_400).times(ratio('365.25')); // IAU Julian year = 365.25 d
const M_PER_LY = ratio(299_792_458).times(SECONDS_PER_JULIAN_YEAR); // c × 1 Julian year = 9 460 730 472 580 800 m
const L_PER_QT_IMP = L_PER_GAL_IMP.dividedBy(4);
const L_PER_PT_IMP = L_PER_QT_IMP.dividedBy(2);
const L_PER_FLOZ_IMP = L_PER_PT_IMP.dividedBy(20); // imperial pint = 20 imperial fluid ounces
const J_PER_EV = ratio('1.602176634e-19'); // electron-volt, exact since SI 2019 (e = 1.602176634e-19 C)
const KG_PER_CT = ratio('0.0002'); // metric carat, 200 mg exactly
const BQ_PER_CI = ratio('3.7e10'); // curie, exact by definition

function lengthFactors(): Record<LengthUnit, Factor> {
  return {
    nm: lin(ratio(1, 1_000_000_000)),
    µm: lin(ratio(1, 1_000_000)),
    mm: lin(ratio(1, 1000)),
    cm: lin(ratio(1, 100)),
    dm: lin(ratio(1, 10)),
    m: lin(ratio(1)),
    km: lin(ratio(1000)),
    in: lin(M_PER_IN),
    ft: lin(M_PER_FT),
    yd: lin(M_PER_YD),
    fathom: lin(M_PER_FT.times(6)), // 6 international feet exactly
    mi: lin(M_PER_MI),
    nmi: lin(M_PER_NMI),
    au: lin(M_PER_AU),
    ly: lin(M_PER_LY),
    pc: { r: M_PER_AU.times(648_000), pi: -1 }, // IAU 2015 Resolution B2: 648000/π au
  };
}

function massFactors(): Record<MassUnit, Factor> {
  return {
    mg: lin(ratio(1, 1_000_000)),
    ct: lin(KG_PER_CT),
    g: lin(ratio(1, 1000)),
    kg: lin(ratio(1)),
    t: lin(ratio(1000)),
    oz: lin(KG_PER_LB.dividedBy(16)),
    lb: lin(KG_PER_LB),
    st: lin(KG_PER_LB.times(14)),
    ton_us: lin(KG_PER_LB.times(2000)), // short ton
    ton_uk: lin(KG_PER_LB.times(2240)), // long ton
  };
}

function areaFactors(): Record<AreaUnit, Factor> {
  const sq = (metres: Rational): Factor => lin(metres.pow(2));
  return {
    mm2: sq(ratio(1, 1000)),
    cm2: sq(ratio(1, 100)),
    m2: sq(ratio(1)),
    ha: lin(ratio(10_000)),
    km2: sq(ratio(1000)),
    in2: sq(M_PER_IN),
    ft2: sq(M_PER_FT),
    yd2: sq(M_PER_YD),
    ac: lin(M_PER_YD.pow(2).times(4840)),
    mi2: sq(M_PER_MI),
  };
}

function volumeFactors(): Record<VolumeUnit, Factor> {
  return {
    ml: lin(ratio(1, 1000)),
    cl: lin(ratio(1, 100)),
    l: lin(ratio(1)),
    cm3: lin(ratio(1, 1000)),
    m3: lin(ratio(1000)),
    in3: lin(L_PER_IN3),
    ft3: lin(L_PER_IN3.times(1728)),
    yd3: lin(L_PER_IN3.times(46_656)),
    tsp: lin(L_PER_TSP),
    tbsp: lin(L_PER_TBSP),
    floz: lin(L_PER_FLOZ),
    cup: lin(L_PER_CUP),
    pt: lin(L_PER_PT),
    qt: lin(L_PER_QT),
    gal: lin(L_PER_GAL),
    floz_imp: lin(L_PER_FLOZ_IMP),
    pt_imp: lin(L_PER_PT_IMP),
    qt_imp: lin(L_PER_QT_IMP),
    gal_imp: lin(L_PER_GAL_IMP),
  };
}

function timeFactors(): Record<TimeUnit, Factor> {
  return {
    ms: lin(ratio(1, 1000)),
    s: lin(ratio(1)),
    min: lin(ratio(60)),
    h: lin(SECONDS_PER_HOUR),
    d: lin(ratio(86_400)),
    wk: lin(ratio(604_800)),
    month: lin(SECONDS_PER_JULIAN_YEAR.dividedBy(12)),
    year: lin(SECONDS_PER_JULIAN_YEAR),
  };
}

function speedFactors(): Record<SpeedUnit, Factor> {
  return {
    'm/s': lin(ratio(1)),
    'km/h': lin(ratio(1000).dividedBy(SECONDS_PER_HOUR)),
    mph: lin(M_PER_MI.dividedBy(SECONDS_PER_HOUR)),
    kn: lin(M_PER_NMI.dividedBy(SECONDS_PER_HOUR)),
    'ft/s': lin(M_PER_FT),
  };
}

function dataFactors(): Record<DataUnit, Factor> {
  return {
    B: lin(ratio(1)),
    kB: lin(ratio(1000)),
    MB: lin(ratio(1000).pow(2)),
    GB: lin(ratio(1000).pow(3)),
    TB: lin(ratio(1000).pow(4)),
    PB: lin(ratio(1000).pow(5)),
    EB: lin(ratio(1000).pow(6)),
    KiB: lin(ratio(1024)),
    MiB: lin(ratio(1024).pow(2)),
    GiB: lin(ratio(1024).pow(3)),
    TiB: lin(ratio(1024).pow(4)),
    PiB: lin(ratio(1024).pow(5)),
    EiB: lin(ratio(1024).pow(6)),
    bit: lin(ratio(1, 8)),
    kbit: lin(ratio(1000, 8)),
    Mbit: lin(ratio(1_000_000, 8)),
    Gbit: lin(ratio(1_000_000_000, 8)),
    Kibit: lin(ratio(1024, 8)),
    Mibit: lin(ratio(1024 ** 2, 8)),
    Gibit: lin(ratio(1024 ** 3, 8)),
  };
}

function energyFactors(): Record<EnergyUnit, Factor> {
  const calorie = ratio('4.184'); // thermochemical calorie
  return {
    J: lin(ratio(1)),
    kJ: lin(ratio(1000)),
    cal: lin(calorie),
    kcal: lin(calorie.times(1000)),
    Wh: lin(SECONDS_PER_HOUR),
    kWh: lin(SECONDS_PER_HOUR.times(1000)),
    MJ: lin(ratio(1_000_000)),
    GJ: lin(ratio(1_000_000_000)),
    BTU: lin(J_PER_BTU),
    eV: lin(J_PER_EV),
    'ft*lbf': lin(M_PER_FT.times(N_PER_LBF)), // 1.3558179483314004 J, exact: 0.3048 m × 0.45359237 kg × 9.80665 m/s²
  };
}

function pressureFactors(): Record<PressureUnit, Factor> {
  return {
    Pa: lin(ratio(1)),
    kPa: lin(ratio(1000)),
    MPa: lin(ratio(1_000_000)),
    bar: lin(ratio(100_000)),
    atm: lin(PA_PER_ATM),
    // 1 psi = 1 lbf / 1 in², with 1 lbf = 1 lb × standard gravity.
    psi: lin(KG_PER_LB.times(G_STANDARD).dividedBy(M_PER_IN.pow(2))),
    mmHg: lin(PA_PER_ATM.dividedBy(760)),
    Torr: lin(PA_PER_ATM.dividedBy(760)), // defined as 1/760 atm
  };
}

/** Base unit is the radian: `deg = π/180`, `grad = π/200`, `turn = 2π`. */
function angleFactors(): Record<AngleUnit, Factor> {
  return {
    deg: { r: ratio(1, 180), pi: 1 },
    rad: { r: ratio(1), pi: 0 },
    grad: { r: ratio(1, 200), pi: 1 },
    turn: { r: ratio(2), pi: 1 },
    arcmin: { r: ratio(1, 10_800), pi: 1 }, // 1/60 deg
    arcsec: { r: ratio(1, 648_000), pi: 1 }, // 1/3600 deg
  };
}

/** Base unit is the steradian: `deg2 = (π/180)²`, the solid angle of a 1° × 1° square. */
function solidAngleFactors(): Record<SolidAngleUnit, Factor> {
  return {
    sr: { r: ratio(1), pi: 0 },
    deg2: { r: ratio(1, 32_400), pi: 2 },
  };
}

/** Base unit is the ampere. */
function electricCurrentFactors(): Record<ElectricCurrentUnit, Factor> {
  return {
    µA: lin(ratio(1, 1_000_000)),
    mA: lin(ratio(1, 1000)),
    A: lin(ratio(1)),
    kA: lin(ratio(1000)),
  };
}

/** Base unit is the lux (lm/m²). A foot-candle is one lumen per square foot. */
function illuminanceFactors(): Record<IlluminanceUnit, Factor> {
  return {
    lx: lin(ratio(1)),
    fc: lin(ratio(1).dividedBy(M_PER_FT.pow(2))),
  };
}

/** Base unit is the becquerel (1/s). */
function radioactivityFactors(): Record<RadioactivityUnit, Factor> {
  return {
    Bq: lin(ratio(1)),
    kBq: lin(ratio(1000)),
    MBq: lin(ratio(1_000_000)),
    µCi: lin(BQ_PER_CI.dividedBy(1_000_000)),
    mCi: lin(BQ_PER_CI.dividedBy(1000)),
    Ci: lin(BQ_PER_CI),
  };
}

/** Base unit is the pascal second. 1 P (poise) = 0.1 Pa·s; 1 cP = 1 mPa·s. */
function dynamicViscosityFactors(): Record<DynamicViscosityUnit, Factor> {
  return {
    'Pa*s': lin(ratio(1)),
    'mPa*s': lin(ratio(1, 1000)),
    P: lin(ratio(1, 10)),
    cP: lin(ratio(1, 1000)),
  };
}

/** Base unit is m²/s. 1 St (stokes) = 1 cm²/s = 10⁻⁴ m²/s; 1 cSt = 10⁻⁶ m²/s. */
function kinematicViscosityFactors(): Record<KinematicViscosityUnit, Factor> {
  return {
    'm2/s': lin(ratio(1)),
    cSt: lin(ratio(1, 1_000_000)),
    St: lin(ratio(1, 10_000)),
  };
}

function powerFactors(): Record<PowerUnit, Factor> {
  return {
    W: lin(ratio(1)),
    kW: lin(ratio(1000)),
    MW: lin(ratio(1_000_000)),
    // Mechanical horsepower = 550 ft·lbf/s = 745.69987158227022 W (exact).
    hp: lin(ratio(550).times(M_PER_FT).times(N_PER_LBF)),
    // Metric horsepower (PS, CV) = 75 kgf·m/s = 735.49875 W (exact).
    hp_metric: lin(ratio(75).times(N_PER_KGF)),
    'BTU/h': lin(J_PER_BTU.dividedBy(SECONDS_PER_HOUR)),
    'kcal/h': lin(ratio('4184').dividedBy(SECONDS_PER_HOUR)), // thermochemical kilocalorie, as `kcal`
  };
}

function frequencyFactors(): Record<FrequencyUnit, Factor> {
  return {
    Hz: lin(ratio(1)),
    kHz: lin(ratio(1000)),
    MHz: lin(ratio(1_000_000)),
    GHz: lin(ratio(1_000_000_000)),
    rpm: lin(ratio(1, 60)),
  };
}

function forceFactors(): Record<ForceUnit, Factor> {
  return {
    N: lin(ratio(1)),
    kN: lin(ratio(1000)),
    lbf: lin(N_PER_LBF),
    kgf: lin(N_PER_KGF),
    dyn: lin(ratio(1, 100_000)), // 1 dyn = 1 g·cm/s² = 10⁻⁵ N
  };
}

function torqueFactors(): Record<TorqueUnit, Factor> {
  return {
    'N*m': lin(ratio(1)),
    'lbf*ft': lin(N_PER_LBF.times(M_PER_FT)),
    'kgf*m': lin(N_PER_KGF),
  };
}

/**
 * Base unit is km/l. `l/100km` is not here: it is the reciprocal of this scale
 * (`l/100km = 100 / (km/l)`), handled beside temperature, not as a factor.
 */
function fuelEconomyFactors(): Record<Exclude<FuelEconomyUnit, 'l/100km'>, Factor> {
  const kmPerMile = M_PER_MI.dividedBy(1000);
  return {
    'km/l': lin(ratio(1)),
    mpg: lin(kmPerMile.dividedBy(L_PER_GAL)),
    mpg_imp: lin(kmPerMile.dividedBy(L_PER_GAL_IMP)),
  };
}

/** Base unit is the bit per second; a byte is 8 bits, `kB`/`MB`/`GB` are decimal, `MiB` is binary. */
function dataRateFactors(): Record<DataRateUnit, Factor> {
  const byte = 8;
  return {
    'bit/s': lin(ratio(1)),
    'kbit/s': lin(ratio(1000)),
    'Mbit/s': lin(ratio(1_000_000)),
    'Gbit/s': lin(ratio(1_000_000_000)),
    'B/s': lin(ratio(byte)),
    'kB/s': lin(ratio(byte * 1000)),
    'MB/s': lin(ratio(byte * 1_000_000)),
    'GB/s': lin(ratio(byte * 1_000_000_000)),
    'MiB/s': lin(ratio(1024).pow(2).times(byte)),
  };
}

/** Categories converted by one multiplication. Temperature is affine and `l/100km` reciprocal. */
type LinearCategory = Exclude<UnitCategory, 'temperature'>;

const FACTOR_BUILDERS: Record<LinearCategory, () => Readonly<Record<string, Factor>>> = {
  length: lengthFactors,
  mass: massFactors,
  area: areaFactors,
  volume: volumeFactors,
  time: timeFactors,
  speed: speedFactors,
  data: dataFactors,
  energy: energyFactors,
  pressure: pressureFactors,
  angle: angleFactors,
  solidAngle: solidAngleFactors,
  power: powerFactors,
  frequency: frequencyFactors,
  force: forceFactors,
  torque: torqueFactors,
  fuelEconomy: fuelEconomyFactors,
  dataRate: dataRateFactors,
  electricCurrent: electricCurrentFactors,
  illuminance: illuminanceFactors,
  radioactivity: radioactivityFactors,
  dynamicViscosity: dynamicViscosityFactors,
  kinematicViscosity: kinematicViscosityFactors,
};

// Tables are built on first use of their category, so importing the module costs nothing.
const factorTables = new Map<UnitCategory, Readonly<Record<string, Factor>>>();

function factorOf(category: LinearCategory, unit: Unit): Factor {
  let table = factorTables.get(category);
  if (table === undefined) {
    table = FACTOR_BUILDERS[category]();
    factorTables.set(category, table);
  }
  const factor = table[unit];
  if (factor === undefined) throw new InvalidArgumentError(`Unknown ${category} unit "${unit}"`);
  return factor;
}

// Temperature (affine, exact rationals) ----------------------------------------

const KELVIN_OFFSET = ratio('273.15');
const NINE_FIFTHS = ratio(9, 5);
const FIVE_NINTHS = ratio(5, 9);

function toCelsiusExact(value: Rational, from: TemperatureUnit): Rational {
  if (from === 'C') return value;
  if (from === 'K') return value.minus(KELVIN_OFFSET);
  return value.minus(32).times(FIVE_NINTHS);
}

function fromCelsiusExact(celsius: Rational, to: TemperatureUnit): Rational {
  if (to === 'C') return celsius;
  if (to === 'K') return celsius.plus(KELVIN_OFFSET);
  return celsius.times(NINE_FIFTHS).plus(32);
}

function toCelsius(value: number, from: TemperatureUnit): number {
  if (from === 'C') return value;
  if (from === 'K') return value - 273.15;
  return (value - 32) * (5 / 9);
}

function fromCelsius(celsius: number, to: TemperatureUnit): number {
  if (to === 'C') return celsius;
  if (to === 'K') return celsius + 273.15;
  return celsius * 1.8 + 32;
}

// Fuel economy: l/100km is the reciprocal of km/l ---------------------------------

const L_PER_100_KM = 'l/100km';

function reciprocalOfZero(unit: Unit): never {
  throw new InvalidArgumentError(`0 ${unit} has no fuel-economy counterpart: its reciprocal is infinite`);
}

/** Converts in doubles; at most one side is `l/100km`, so at most one reciprocal is taken. */
function convertFuelEconomy(value: number, from: Unit, to: Unit): number {
  if (from === L_PER_100_KM) {
    if (value === 0) return reciprocalOfZero(from);
    return (100 / value) * pairFactor('fuelEconomy', 'km/l', to);
  }
  if (to === L_PER_100_KM) {
    const kmPerLitre = value * pairFactor('fuelEconomy', from, 'km/l');
    if (kmPerLitre === 0) return reciprocalOfZero(from);
    return 100 / kmPerLitre;
  }
  return value * pairFactor('fuelEconomy', from, to);
}

function convertFuelEconomyExact(value: Rational, from: Unit, to: Unit): Rational {
  if (from === L_PER_100_KM) {
    if (value.isZero()) return reciprocalOfZero(from);
    return ratio(100)
      .dividedBy(value)
      .times(factorOf('fuelEconomy', 'km/l').r)
      .dividedBy(factorOf('fuelEconomy', to).r);
  }
  const kmPerLitre = value.times(factorOf('fuelEconomy', from).r).dividedBy(factorOf('fuelEconomy', 'km/l').r);
  if (to !== L_PER_100_KM) return kmPerLitre.dividedBy(factorOf('fuelEconomy', to).r);
  if (kmPerLitre.isZero()) return reciprocalOfZero(from);
  return ratio(100).dividedBy(kmPerLitre);
}

// Public API -------------------------------------------------------------------

/** True when `value` is one of the supported unit symbols (case sensitive). */
export function isUnit(value: string): value is Unit {
  return CATEGORY_OF.has(value);
}

/** The category a unit belongs to. */
export function unitCategory(unit: Unit): UnitCategory {
  const category = CATEGORY_OF.get(unit);
  if (category === undefined) throw new InvalidArgumentError(`Unknown unit "${unit}"`);
  return category;
}

/** Every unit symbol in a category, in display order. */
export function unitsOf(category: UnitCategory): readonly Unit[] {
  return UNITS_BY_CATEGORY[category];
}

function sharedCategory(from: Unit, to: Unit): UnitCategory {
  const fromCategory = CATEGORY_OF.get(from);
  const toCategory = CATEGORY_OF.get(to);
  if (fromCategory === undefined && toCategory === undefined) {
    throw new InvalidArgumentError(`Unknown units "${from}" and "${to}"`);
  }
  if (fromCategory === undefined || toCategory === undefined) {
    const known = fromCategory ?? toCategory;
    const bad = fromCategory === undefined ? from : to;
    if (known === undefined) throw new InvalidArgumentError(`Unknown unit "${bad}"`);
    throw new InvalidArgumentError(`Unknown unit "${bad}"; ${known} units are: ${unitsOf(known).join(', ')}`);
  }
  if (fromCategory !== toCategory) {
    throw new InvalidArgumentError(`Cannot convert ${fromCategory} ("${from}") to ${toCategory} ("${to}")`);
  }
  return fromCategory;
}

// Rounded once per (from, to) pair; a conversion is then a single multiply.
const pairFactors = new Map<string, number>();

function pairFactor(category: LinearCategory, from: Unit, to: Unit): number {
  const key = `${from}\u0000${to}`;
  const cached = pairFactors.get(key);
  if (cached !== undefined) return cached;
  const f = factorOf(category, from);
  const t = factorOf(category, to);
  const exact = f.r.dividedBy(t.r).toNumber();
  const power = f.pi - t.pi;
  const factor = power === 0 ? exact : power > 0 ? exact * Math.PI ** power : exact / Math.PI ** -power;
  pairFactors.set(key, factor);
  return factor;
}

/**
 * Converts `value` between two units of the same category, in doubles.
 * `convert(1, 'in', 'cm')` is exactly `2.54`; `convert(100, 'C', 'F')` is `212`.
 * Throws `InvalidArgumentError` for unknown units or units of different categories,
 * and for `0` to or from `l/100km` (zero fuel use or zero distance per litre is infinite).
 */
export function convert(value: number, from: Unit, to: Unit): number {
  assertFinite(value, 'value');
  const category = sharedCategory(from, to);
  if (from === to) return value;
  if (category === 'temperature') {
    return fromCelsius(toCelsius(value, from as TemperatureUnit), to as TemperatureUnit);
  }
  if (category === 'fuelEconomy') return convertFuelEconomy(value, from, to);
  return value * pairFactor(category, from, to);
}

/**
 * Converts exactly, returning a `Rational`. Linear categories multiply by an
 * exact ratio; temperature applies its exact affine formulas
 * (`°F = °C × 9/5 + 32`, `K = °C + 273.15`); `l/100km` takes the exact
 * reciprocal (`mpg` → `l/100km` is `100 / km-per-litre`).
 *
 * Angles between `deg`, `grad`, `turn`, `arcmin` and `arcsec` are exact; so are `sr` to `sr` and `deg2` to `deg2`. Any conversion between
 * `rad` and another angle unit (or `sr` and `deg2`) needs π and throws `RoundingNecessaryError`
 * (`rad` to `rad` is fine). Use `convert` for those.
 */
export function convertExact(value: RationalInput, from: Unit, to: Unit): Rational {
  const input = Rational.from(value);
  const category = sharedCategory(from, to);
  if (from === to) return input;
  if (category === 'temperature') {
    return fromCelsiusExact(toCelsiusExact(input, from as TemperatureUnit), to as TemperatureUnit);
  }
  if (category === 'fuelEconomy') return convertFuelEconomyExact(input, from, to);
  const f = factorOf(category, from);
  const t = factorOf(category, to);
  if (f.pi !== t.pi) {
    throw new RoundingNecessaryError(`Converting ${from} to ${to} involves π and has no exact rational result`);
  }
  return input.times(f.r).dividedBy(t.r);
}

// Composite values: splitUnits / joinUnits -----------------------------------------

/** One part of a composite value, such as the `7 in` of "5 ft 7 in". */
export type UnitPart = { readonly unit: Unit; readonly value: number };

export type SplitUnitsOptions = {
  /**
   * Fraction digits kept on the last part. Leave it out to keep the exact remainder
   * (as a double). The value is rounded once, in the last unit, before it is split,
   * so a rounded-up remainder carries into the larger parts: 5 ft 11.6 in at
   * `scale: 0` is 6 ft 0 in, never 5 ft 12 in.
   */
  scale?: number;
  /** How to round to `scale`. Defaults to `'halfUp'`. Ignored without `scale`. */
  rounding?: RoundingMode;
};

/** Rejects units that are not a plain multiple of a base unit, so that parts can be added. */
function assertSplittable(category: UnitCategory): void {
  if (category === 'temperature' || category === 'fuelEconomy') {
    throw new InvalidArgumentError(`${category} units are not additive and cannot be split or joined`);
  }
}

/**
 * Splits a value into whole parts of larger units plus a remainder, for display like
 * "5 ft 7 in", "1 h 30 min" or "3 lb 4 oz". `units` go largest first and share one
 * category: `splitUnits(67, 'in', ['ft', 'in'])` is `[{ unit: 'ft', value: 5 }, { unit: 'in', value: 7 }]`.
 *
 * Every part but the last is an integer; the last holds the remainder. The parts add up
 * to the input exactly (`joinUnits` is the inverse), because the arithmetic uses the exact
 * rational factors, not doubles. A negative value puts its sign on the first non-zero
 * part only, so `-67 in` is `-5 ft` and `7 in`, meaning minus (5 ft + 7 in); `joinUnits` reads it back the same way.
 *
 * Throws `InvalidArgumentError` for an empty list, unknown or mixed categories, units not
 * strictly largest-first, temperature and fuel economy (not additive), or a non-finite
 * `value`; `RoundingNecessaryError` for units that mix π (such as `rad` with `deg`).
 */
export function splitUnits(
  value: RationalInput,
  from: Unit,
  units: readonly Unit[],
  options: SplitUnitsOptions = {},
): UnitPart[] {
  if (typeof value === 'number') assertFinite(value, 'value');
  const last = units.at(-1);
  if (last === undefined) throw new InvalidArgumentError('splitUnits needs at least one unit');
  assertSplittable(sharedCategory(from, last));
  // Size of every unit in the last (smallest) unit; also checks the category and π.
  const sizes = units.map(unit => convertExact(1, unit, last));
  for (let i = 1; i < sizes.length; i++) {
    const previous = sizes[i - 1];
    const current = sizes[i];
    if (previous === undefined || current === undefined || !previous.gt(current)) {
      throw new InvalidArgumentError(`Units must be given largest first without repeats: "${units.join('", "')}"`);
    }
  }

  let remaining = convertExact(value, from, last);
  if (options.scale !== undefined) {
    remaining = Rational.from(remaining.toDecimal({ scale: options.scale, rounding: options.rounding ?? 'halfUp' }));
  }
  const negative = remaining.isNegative();
  remaining = remaining.abs();

  const out: UnitPart[] = [];
  let signPending = negative;
  for (const [index, unit] of units.entries()) {
    const size = sizes[index];
    if (size === undefined) continue;
    let magnitude: number;
    if (index === units.length - 1) {
      magnitude = remaining.toNumber();
    } else {
      // `remaining` is non-negative, so integer division is the floor.
      const quotient = remaining.dividedBy(size);
      const whole = quotient.numerator / quotient.denominator;
      remaining = remaining.minus(size.times(whole));
      magnitude = Number(whole);
    }
    const carriesSign = signPending && magnitude !== 0;
    if (carriesSign) signPending = false;
    out.push({ unit, value: carriesSign ? -magnitude : magnitude });
  }
  return out;
}

/**
 * Adds composite parts back into one number in `to`: `joinUnits([{ unit: 'ft', value: 5 },
 * { unit: 'in', value: 7 }], 'in')` is `67`. Parts may come in any order and may be fractional.
 * It reads parts the way `splitUnits` writes them: the sign of the first non-zero part applies
 * to the whole value, so `-5 ft 7 in` is minus (5 ft + 7 in), `-67 in`. Later parts must not
 * be negative (`InvalidArgumentError`); that would be ambiguous. The sum is exact, rounded to
 * a double once at the end.
 */
export function joinUnits(parts: readonly UnitPart[], to: Unit): number {
  if (parts.length === 0) throw new InvalidArgumentError('joinUnits needs at least one part');
  let total = ratio(0);
  let negative = false;
  let seenNonZero = false;
  for (const part of parts) {
    assertSplittable(sharedCategory(part.unit, to));
    assertFinite(part.value, 'value');
    if (part.value !== 0) {
      if (!seenNonZero) negative = part.value < 0;
      else if (part.value < 0) {
        throw new InvalidArgumentError(
          'Only the first non-zero part may be negative; its sign applies to the whole value',
        );
      }
      seenNonZero = true;
    }
    total = total.plus(convertExact(Math.abs(part.value), part.unit, to));
  }
  const sum = total.toNumber();
  return negative ? -sum : sum;
}

// formatUnit -------------------------------------------------------------------

/** Our symbols mapped to the identifiers `Intl.NumberFormat` accepts for `style: 'unit'`. */
const INTL_UNITS: Partial<Record<Unit, string>> = {
  mm: 'millimeter',
  cm: 'centimeter',
  m: 'meter',
  km: 'kilometer',
  in: 'inch',
  ft: 'foot',
  yd: 'yard',
  mi: 'mile',
  g: 'gram',
  kg: 'kilogram',
  oz: 'ounce',
  lb: 'pound',
  st: 'stone',
  ha: 'hectare',
  ac: 'acre',
  ml: 'milliliter',
  l: 'liter',
  floz: 'fluid-ounce',
  gal: 'gallon',
  C: 'celsius',
  F: 'fahrenheit',
  ms: 'millisecond',
  s: 'second',
  min: 'minute',
  h: 'hour',
  d: 'day',
  wk: 'week',
  month: 'month',
  year: 'year',
  'm/s': 'meter-per-second',
  'km/h': 'kilometer-per-hour',
  mph: 'mile-per-hour',
  B: 'byte',
  kB: 'kilobyte',
  MB: 'megabyte',
  GB: 'gigabyte',
  TB: 'terabyte',
  PB: 'petabyte',
  bit: 'bit',
  kbit: 'kilobit',
  Mbit: 'megabit',
  Gbit: 'gigabit',
  deg: 'degree',
};

/** Display symbols for units whose key is not how people write them (used when Intl has no name). */
const SYMBOLS: Partial<Record<Unit, string>> = {
  hp_metric: 'PS',
  cm3: 'cm³',
  in3: 'in³',
  ft3: 'ft³',
  yd3: 'yd³',
  floz_imp: 'fl oz (imp)',
  pt_imp: 'pt (imp)',
  qt_imp: 'qt (imp)',
  gal_imp: 'gal (imp)',
  ton_us: 'ton (US)',
  ton_uk: 'ton (UK)',
  'ft*lbf': 'ft·lbf',
  deg2: 'deg²',
  'Pa*s': 'Pa·s',
  'mPa*s': 'mPa·s',
  'm2/s': 'm²/s',
  mpg_imp: 'mpg (imp)',
  'N*m': 'N·m',
  'lbf*ft': 'lbf·ft',
  'kgf*m': 'kgf·m',
};

const MAX_FORMATTERS = 256;
const formatters = new Map<string, Intl.NumberFormat>();

/** Bounded cache: past 256 entries the oldest insertion is evicted. */
function getFormatter(
  locale: string | undefined,
  intlUnit: string | undefined,
  display: 'short' | 'narrow' | 'long',
  maximumFractionDigits: number | undefined,
): Intl.NumberFormat {
  const key = `${locale ?? ''}|${intlUnit ?? ''}|${display}|${maximumFractionDigits ?? ''}`;
  const cached = formatters.get(key);
  if (cached) return cached;
  const created =
    intlUnit === undefined
      ? new Intl.NumberFormat(locale, { maximumFractionDigits })
      : new Intl.NumberFormat(locale, { style: 'unit', unit: intlUnit, unitDisplay: display, maximumFractionDigits });
  if (formatters.size >= MAX_FORMATTERS) {
    const oldest = formatters.keys().next();
    if (!oldest.done) formatters.delete(oldest.value);
  }
  formatters.set(key, created);
  return created;
}

/**
 * Formats `value` with its unit through `Intl.NumberFormat`: `formatUnit(5, 'km')`
 * is `'5 km'`, and with `{ display: 'long' }` it is `'5 kilometers'`. Units Intl
 * has no name for (`nmi`, `psi`, `rad`, `K`, ...) print as the number, a space and
 * the symbol; `display` does not apply to them. Power, frequency, force, torque,
 * fuel economy and data rates all take this path (`Intl` names none of them),
 * with `hp_metric` shown as `PS` and `N*m` as `N·m`.
 */
export function formatUnit(value: number, unit: Unit, options: FormatUnitOptions = {}): string {
  assertFinite(value, 'value');
  unitCategory(unit);
  const { locale, display = 'short', maximumFractionDigits } = options;
  const intlUnit = INTL_UNITS[unit];
  if (intlUnit === undefined) {
    const number = getFormatter(locale, undefined, 'short', maximumFractionDigits).format(value);
    return `${number} ${SYMBOLS[unit] ?? unit}`;
  }
  return getFormatter(locale, intlUnit, display, maximumFractionDigits).format(value);
}
