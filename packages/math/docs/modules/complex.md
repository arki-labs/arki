Back to the [README](../../README.md#documentation).

# @arki/math/complex

Immutable `Complex` with the same verbs as `Decimal`. Principal branches for
`sqrt`, `ln` and `pow`; division by zero throws instead of giving `NaN`.
`toString()` prints `3 + 4i` and parses back exactly.

```ts
import { complex } from '@arki/math/complex';

complex(1, 1).pow(2).toString(); // '2i'
complex('3+4i').abs(); // 5
complex(-1).sqrt().toString(); // 'i'
complex(1).nthRoots(3).length; // 3
complex(1, 1).sin().toString(); // '1.2984575814159773 + 0.6349639147847361i'
complex(2).asin().toString(); // '1.5707963267948966 - 1.3169578969248166i'
```

`sin`, `cos`, `tan`, their inverses and the hyperbolic functions use principal
branches (C99 Annex G). The library has no `-0`, so a point exactly on a branch
cut takes Kahan's counter-clockwise rule, like `sqrt` and `ln` and like mpmath
and Mathematica; C and NumPy pick the other side on half of the cuts.
Measured within 3.1 ulp of a 700-digit reference from 1e-300 to 1e300.
