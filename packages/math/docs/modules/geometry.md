Back to the [README](../../README.md#documentation).

# @arki/math/geometry

Radians by default; pass `{ angleUnit: 'deg' }` (any angle unit from
`units`) to work in degrees. `solveTriangles` takes any three parts that fix a
triangle and returns every triangle they describe: SSA can give 0, 1 or 2.
`solveTriangle` returns the one triangle and throws when there are none or two.
Areas use stable formulas (Kahan's Heron), so needle-thin triangles stay accurate.

```ts
import { circle, polygonArea, solveTriangle, solveTriangles, sphere } from '@arki/math/geometry';

solveTriangle({ a: 3, b: 4, c: 5 }).area; // 6
solveTriangles({ a: 7, b: 10, A: 30 }, { angleUnit: 'deg' }).length; // 2   the ambiguous case
circle(2).area; // 12.566370614359172
sphere(1).volume; // 4.1887902047863905
polygonArea([
  [0, 0],
  [4, 0],
  [4, 3],
]); // 6
```
