Back to the [README](../../README.md#documentation).

# @arki/math/units

Twenty-two categories (length, mass, area, volume, temperature, time, speed,
data, energy, pressure, angle, power, frequency, force, torque, fuel economy,
data rate, electric current, illuminance, radioactivity, dynamic and kinematic
viscosity, solid angle) with every factor stored as an exact
rational, so `convert(1, 'in', 'cm')` is exactly `2.54` and
`convert(100, 'C', 'F')` is exactly `212`. `convertExact` returns the
`Rational`; only conversions through π (radians) refuse to be exact. Fuel
economy mixes distance-per-volume and volume-per-distance units:
`l/100km` is the reciprocal of `km/l`, so `convert(30, 'mpg', 'l/100km')` is
`7.84…`, and converting `0` to or from `l/100km` throws.

```ts
import { convert, convertExact, formatUnit, joinUnits, splitUnits, unitsOf } from '@arki/math/units';

convert(5, 'km', 'mi'); // 3.1068559611866697
convert(1, 'GiB', 'GB'); // 1.073741824
convertExact(1, 'mi', 'km').toString(); // '25146/15625'
convert(1, 'm', 'kg'); // throws InvalidArgumentError: length → mass
formatUnit(5, 'km', { display: 'long' }); // '5 kilometers'
unitsOf('pressure'); // ['Pa', 'kPa', 'MPa', 'bar', 'atm', 'psi', 'mmHg', 'Torr']
splitUnits(67, 'in', ['ft', 'in']); // [{ unit: 'ft', value: 5 }, { unit: 'in', value: 7 }]
splitUnits(71.99, 'in', ['ft', 'in'], { scale: 0 }); // 6 ft 0 in   rounds once, then carries
joinUnits(
  [
    { unit: 'ft', value: 5 },
    { unit: 'in', value: 7 },
  ],
  'in',
); // 67
```
