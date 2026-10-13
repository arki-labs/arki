import { describe, expect, it } from 'vitest';

import { InvalidArgumentError } from './errors.js';
import {
  circle,
  circleSector,
  cone,
  cube,
  cuboid,
  cylinder,
  distance,
  ellipse,
  frustum,
  isPythagoreanTriple,
  midpoint,
  polygonArea,
  pythagoreanTriples,
  regularPolygon,
  signedPolygonArea,
  solveTriangle,
  solveTriangles,
  sphere,
  squarePyramid,
  torus,
} from './geometry.js';

const deg = { angleUnit: 'deg' } as const;

describe('solveTriangle: SSS', () => {
  it('solves the 3-4-5 right triangle (area ab/2 = 6, C = 90°)', () => {
    const t = solveTriangle({ a: 3, b: 4, c: 5 });
    expect(t.area).toBe(6);
    expect(t.perimeter).toBe(12);
    expect(t.C).toBeCloseTo(Math.PI / 2, 15);
    // sin A = 3/5 and sin B = 4/5 in a right triangle.
    expect(t.A).toBeCloseTo(Math.asin(3 / 5), 15);
    expect(t.B).toBeCloseTo(Math.asin(4 / 5), 15);
    expect(t.angleType).toBe('right');
    expect(t.sideType).toBe('scalene');
  });
  it('solves an equilateral triangle (area √3/4·s², every angle 60°)', () => {
    const t = solveTriangle({ a: 2, b: 2, c: 2 }, deg);
    expect(t.area).toBeCloseTo(Math.sqrt(3), 14);
    for (const angle of [t.A, t.B, t.C]) expect(angle).toBeCloseTo(60, 12);
    expect(t.sideType).toBe('equilateral');
    expect(t.angleType).toBe('acute');
  });
  it('solves the obtuse 2-3-4 triangle (cos C = -1/4, Heron area √8.4375)', () => {
    const t = solveTriangle({ a: 2, b: 3, c: 4 });
    expect(t.C).toBeCloseTo(Math.acos(-0.25), 14);
    expect(t.area).toBeCloseTo(Math.sqrt(4.5 * 2.5 * 1.5 * 0.5), 14);
    expect(t.angleType).toBe('obtuse');
  });
  it('keeps the area of a needle triangle accurate (naive Heron loses it to cancellation)', () => {
    // Kahan's example: a = b = 100000, c = 0.01 → area ≈ c/2·√(a² − c²/4) ≈ 500.
    const t = solveTriangle({ a: 100_000, b: 100_000, c: 0.01 });
    expect(t.area).toBeCloseTo(0.005 * Math.sqrt(1e10 - 0.000_025), 9);
  });
  it('rejects sides that break the triangle inequality, including the degenerate 1-2-3', () => {
    expect(() => solveTriangle({ a: 1, b: 2, c: 3 })).toThrow(InvalidArgumentError);
    expect(() => solveTriangle({ a: 1, b: 2, c: 10 })).toThrow(/triangle inequality/);
    expect(solveTriangles({ a: 1, b: 2, c: 3 })).toEqual([]);
  });
});

describe('solveTriangle: SAS, ASA, AAS', () => {
  it('SAS: a=5, b=7, C=60° gives c = √39 and area ½ab·sin C', () => {
    const t = solveTriangle({ a: 5, b: 7, C: 60 }, deg);
    expect(t.c).toBeCloseTo(Math.sqrt(39), 14);
    expect(t.area).toBeCloseTo(0.5 * 5 * 7 * Math.sin(Math.PI / 3), 13);
    expect(t.A + t.B + t.C).toBeCloseTo(180, 12);
    expect(t.C).toBe(60); // the given angle comes back untouched
  });
  it('SAS stays accurate for a tiny included angle (naive law of cosines cancels)', () => {
    // c ≈ a·C for a = b and small C; with C = 1e-8 rad, c = 2a·sin(C/2).
    const t = solveTriangle({ a: 1, b: 1, C: 1e-8 });
    expect(t.c).toBeCloseTo(2 * Math.sin(5e-9), 22);
    expect(t.sideType).toBe('isosceles');
  });
  it('ASA: A=30°, B=60°, c=2 is the 30-60-90 triangle with sides 1, √3, 2', () => {
    const t = solveTriangle({ A: 30, B: 60, c: 2 }, deg);
    expect(t.a).toBeCloseTo(1, 14);
    expect(t.b).toBeCloseTo(Math.sqrt(3), 14);
    expect(t.C).toBeCloseTo(90, 12);
    expect(t.angleType).toBe('right');
  });
  it('AAS: A=30°, B=45°, a=10 gives b = 10√2 and c = 20·sin 105° by the law of sines', () => {
    const t = solveTriangle({ A: 30, B: 45, a: 10 }, deg);
    expect(t.b).toBeCloseTo(10 * Math.SQRT2, 13);
    expect(t.c).toBeCloseTo(20 * Math.sin((105 * Math.PI) / 180), 13);
    expect(t.C).toBeCloseTo(105, 12);
  });
  it('rejects two angles that leave no room for a third', () => {
    expect(() => solveTriangle({ A: 100, B: 80, a: 1 }, deg)).toThrow(/half turn or more/);
    expect(solveTriangles({ A: 120, B: 70, c: 1 }, deg)).toEqual([]);
  });
});

describe('solveTriangles: SSA (the ambiguous case)', () => {
  it('a=7, b=10, A=30° fits two triangles', () => {
    // sin B = 10·sin 30°/7 = 5/7, so B = asin(5/7) ≈ 45.58° or 180° − that ≈ 134.42°.
    // Independently, c solves c² − 2bc·cos A + b² − a² = 0: c = 5√3 ± √24.
    const [first, second, ...rest] = solveTriangles({ a: 7, b: 10, A: 30 }, deg);
    expect(rest).toEqual([]);
    const b1 = (Math.asin(5 / 7) * 180) / Math.PI;
    expect(first?.B).toBeCloseTo(b1, 12);
    expect(first?.C).toBeCloseTo(150 - b1, 12);
    expect(first?.c).toBeCloseTo(5 * Math.sqrt(3) + Math.sqrt(24), 12);
    expect(second?.B).toBeCloseTo(180 - b1, 12);
    expect(second?.C).toBeCloseTo(b1 - 30, 12);
    expect(second?.c).toBeCloseTo(5 * Math.sqrt(3) - Math.sqrt(24), 12);
  });
  it('solveTriangle refuses the ambiguous case instead of picking one silently', () => {
    expect(() => solveTriangle({ a: 7, b: 10, A: 30 }, deg)).toThrow(/solveTriangles/);
  });
  it('gives one triangle when the side opposite the angle is the longer one', () => {
    const triangles = solveTriangles({ a: 10, b: 7, A: 30 }, deg);
    expect(triangles).toHaveLength(1);
    expect(solveTriangle({ a: 10, b: 7, A: 30 }, deg).B).toBeCloseTo((Math.asin(0.35) * 180) / Math.PI, 12);
  });
  it('gives one right triangle when a exactly equals b·sin A, despite rounding in sin 30°', () => {
    // b·sin A = 10·0.5 = 5 = a: the side just touches the base, B = 90°.
    const triangles = solveTriangles({ a: 5, b: 10, A: 30 }, deg);
    expect(triangles).toHaveLength(1);
    expect(triangles[0]?.B).toBe(90); // exact: the solver snaps to the right angle
    expect(triangles[0]?.angleType).toBe('right');
    expect(triangles[0]?.c).toBeCloseTo(Math.sqrt(75), 12);
  });
  it('gives no triangle when the side is shorter than the height b·sin A', () => {
    expect(solveTriangles({ a: 4, b: 10, A: 30 }, deg)).toEqual([]);
    expect(() => solveTriangle({ a: 4, b: 10, A: 30 }, deg)).toThrow(/too short/);
  });
  it('with an obtuse given angle, fits only when the opposite side is the longest', () => {
    expect(solveTriangles({ a: 10, b: 5, A: 120 }, deg)).toHaveLength(1);
    expect(solveTriangles({ a: 5, b: 10, A: 120 }, deg)).toEqual([]);
    expect(solveTriangles({ a: 5, b: 5, A: 120 }, deg)).toEqual([]);
  });
  it('works for any side/angle pairing, not just a, b, A', () => {
    const [t] = solveTriangles({ c: 10, b: 7, C: 30 }, deg);
    expect(t?.B).toBeCloseTo((Math.asin(0.35) * 180) / Math.PI, 12);
  });
});

describe('solveTriangle: units, tolerance and malformed input', () => {
  it('reports angles in the requested unit and returns given angles verbatim', () => {
    const t = solveTriangle({ a: 1, b: 1, C: 0.25 }, { angleUnit: 'turn' });
    expect(t.C).toBe(0.25);
    expect(t.A).toBeCloseTo(0.125, 15);
    expect(solveTriangle({ a: 3, b: 4, c: 5 }, { angleUnit: 'grad' }).C).toBeCloseTo(100, 12);
  });
  it('classifies within the tolerance, so measurement noise still reads as isosceles or right', () => {
    expect(solveTriangle({ a: 1, b: 1 + 1e-12, c: 1.5 }).sideType).toBe('isosceles');
    expect(solveTriangle({ a: 1, b: 1 + 1e-6, c: 1.5 }).sideType).toBe('scalene');
    expect(solveTriangle({ a: 1, b: 1 + 1e-6, c: 1.5 }, { tolerance: 1e-5 }).sideType).toBe('isosceles');
    expect(solveTriangle({ a: 3, b: 4, c: 5.000_000_1 }).angleType).toBe('obtuse');
    expect(solveTriangle({ a: 3, b: 4, c: 5.000_000_1 }, { tolerance: 1e-6 }).angleType).toBe('right');
  });
  it('throws InvalidArgumentError for malformed parts in both functions', () => {
    for (const solve of [solveTriangle, solveTriangles]) {
      expect(() => solve({ a: 0, b: 1, c: 1 })).toThrow(InvalidArgumentError);
      expect(() => solve({ a: -1, b: 1, c: 1 })).toThrow(/positive/);
      expect(() => solve({ a: Number.NaN, b: 1, c: 1 })).toThrow(/finite/);
      expect(() => solve({ a: 1, b: 1 })).toThrow(/exactly three parts/);
      expect(() => solve({ a: 1, b: 1, c: 1, A: 1 })).toThrow(/exactly three parts/);
      expect(() => solve({ A: 1, B: 1, C: 1 })).toThrow(/give a side/);
      expect(() => solve({ a: 1, b: 1, C: 180 }, deg)).toThrow(/half turn/);
      expect(() => solve({ a: 3, b: 4, c: 5 }, { tolerance: -1 })).toThrow(InvalidArgumentError);
    }
  });
});

describe('plane figures', () => {
  it('circle: r = 2 has circumference 4π and area 4π', () => {
    expect(circle(2)).toEqual({ radius: 2, diameter: 4, circumference: 4 * Math.PI, area: 4 * Math.PI });
    expect(() => circle(0)).toThrow(InvalidArgumentError);
  });
  it('circleSector: a quarter of a unit circle', () => {
    const s = circleSector({ radius: 1, angle: 90 }, deg);
    expect(s.arcLength).toBeCloseTo(Math.PI / 2, 15);
    expect(s.chordLength).toBeCloseTo(Math.SQRT2, 15);
    expect(s.sectorArea).toBeCloseTo(Math.PI / 4, 15);
    // Quarter disc minus the right triangle with legs 1 and 1.
    expect(s.segmentArea).toBeCloseTo(Math.PI / 4 - 0.5, 15);
  });
  it('circleSector: a full turn is the whole disc, and tiny angles keep their segment area', () => {
    const full = circleSector({ radius: 3, angle: 2 * Math.PI });
    expect(full.sectorArea).toBeCloseTo(9 * Math.PI, 13);
    expect(full.segmentArea).toBeCloseTo(9 * Math.PI, 13);
    // r²/2·(θ − sin θ) ≈ r²θ³/12 for small θ; θ − Math.sin(θ) would be pure rounding noise here.
    const tiny = circleSector({ radius: 2, angle: 1e-6 });
    expect(tiny.segmentArea / ((4 * 1e-18) / 12)).toBeCloseTo(1, 10);
    expect(() => circleSector({ radius: 1, angle: 361 }, deg)).toThrow(/full turn/);
  });
  it('ellipse: a = 2, b = 1 has perimeter 4·2·E(√3/2) ≈ 9.688448220547675 (WolframAlpha)', () => {
    const e = ellipse({ semiAxisX: 2, semiAxisY: 1 });
    expect(e.perimeter).toBeCloseTo(9.688_448_220_547_675, 13);
    expect(e.area).toBeCloseTo(2 * Math.PI, 15);
    expect(e.eccentricity).toBeCloseTo(Math.sqrt(3) / 2, 15);
    // Axis order does not matter, and a circle is the limit case.
    expect(ellipse({ semiAxisX: 1, semiAxisY: 2 }).perimeter).toBe(e.perimeter);
    expect(ellipse({ semiAxisX: 5, semiAxisY: 5 }).perimeter).toBeCloseTo(10 * Math.PI, 13);
  });
  it('ellipse: a very flat ellipse approaches the 4a perimeter of its doubled major axis', () => {
    expect(ellipse({ semiAxisX: 1, semiAxisY: 1e-9 }).perimeter).toBeCloseTo(4, 7);
  });
  it('regularPolygon: a unit hexagon has area 3√3/2, apothem √3/2 and 120° interior angles', () => {
    const h = regularPolygon({ sides: 6, sideLength: 1 }, deg);
    expect(h.area).toBeCloseTo((3 * Math.sqrt(3)) / 2, 14);
    expect(h.apothem).toBeCloseTo(Math.sqrt(3) / 2, 15);
    expect(h.circumradius).toBeCloseTo(1, 15);
    expect(h.interiorAngle).toBe(120);
    expect(h.exteriorAngle).toBe(60);
    expect(h.perimeter).toBe(6);
  });
  it('regularPolygon: a square of side 2 has area 4 and apothem 1; radians by default', () => {
    const sq = regularPolygon({ sides: 4, sideLength: 2 });
    expect(sq.area).toBeCloseTo(4, 14);
    expect(sq.apothem).toBeCloseTo(1, 15);
    expect(sq.interiorAngle).toBe(Math.PI / 2);
    expect(() => regularPolygon({ sides: 2, sideLength: 1 })).toThrow(InvalidArgumentError);
    expect(() => regularPolygon({ sides: 4.5, sideLength: 1 })).toThrow(InvalidArgumentError);
  });
});

describe('solids', () => {
  it('sphere: r = 3 has volume 36π and surface 36π', () => {
    const s = sphere(3);
    expect(s.volume).toBeCloseTo(36 * Math.PI, 12);
    expect(s.surfaceArea).toBeCloseTo(36 * Math.PI, 12);
  });
  it('cylinder: r = 2, h = 5 holds 20π with lateral 20π and total 28π', () => {
    expect(cylinder({ radius: 2, height: 5 })).toEqual({
      volume: 20 * Math.PI,
      lateralArea: 20 * Math.PI,
      surfaceArea: 28 * Math.PI,
    });
  });
  it('cone: r = 3, h = 4 has slant 5 (3-4-5), volume 12π, lateral 15π, total 24π', () => {
    const c = cone({ radius: 3, height: 4 });
    expect(c.slantHeight).toBe(5);
    expect(c.volume).toBeCloseTo(12 * Math.PI, 13);
    expect(c.lateralArea).toBeCloseTo(15 * Math.PI, 13);
    expect(c.surfaceArea).toBeCloseTo(24 * Math.PI, 13);
  });
  it('frustum: cutting the top off a cone leaves the cone minus the small cone', () => {
    // Cone r = 6, h = 8 minus its top cone r = 3, h = 4 → frustum r1 = 6, r2 = 3, h = 4.
    const f = frustum({ bottomRadius: 6, topRadius: 3, height: 4 });
    const big = cone({ radius: 6, height: 8 });
    const small = cone({ radius: 3, height: 4 });
    expect(f.volume).toBeCloseTo(big.volume - small.volume, 12);
    expect(f.lateralArea).toBeCloseTo(big.lateralArea - small.lateralArea, 12);
    expect(f.slantHeight).toBe(5);
  });
  it('cube and cuboid agree, and the space diagonal follows the 3D Pythagorean theorem', () => {
    expect(cube(2)).toEqual({ volume: 8, surfaceArea: 24, spaceDiagonal: 2 * Math.sqrt(3) });
    const box = cuboid({ length: 2, width: 3, height: 6 });
    expect(box).toEqual({ volume: 36, surfaceArea: 72, spaceDiagonal: 7 }); // 4 + 9 + 36 = 49
  });
  it('squarePyramid: base 6, height 4 has slant 5, volume 48, surface 36 + 60', () => {
    expect(squarePyramid({ baseSide: 6, height: 4 })).toEqual({
      volume: 48,
      slantHeight: 5,
      lateralArea: 60,
      surfaceArea: 96,
    });
  });
  it('torus: R = 3, r = 1 has volume 6π² and surface 12π² (Pappus)', () => {
    const t = torus({ majorRadius: 3, minorRadius: 1 });
    expect(t.volume).toBeCloseTo(6 * Math.PI ** 2, 13);
    expect(t.surfaceArea).toBeCloseTo(12 * Math.PI ** 2, 13);
    expect(() => torus({ majorRadius: 1, minorRadius: 2 })).toThrow(InvalidArgumentError);
  });
  it('rejects non-positive and non-finite dimensions', () => {
    expect(() => sphere(-1)).toThrow(InvalidArgumentError);
    expect(() => cylinder({ radius: 1, height: 0 })).toThrow(/height must be positive/);
    expect(() => cone({ radius: Number.POSITIVE_INFINITY, height: 1 })).toThrow(/finite/);
  });
});

describe('points', () => {
  it('distance in 2D and 3D, accurate where the naive square root overflows', () => {
    expect(distance([0, 0], [3, 4])).toBe(5);
    expect(distance([1, 2, 3], [3, 5, 9])).toBe(7); // 2-3-6-7 quadruple
    expect(distance([0, 0], [3e200, 4e200]) / 5e200).toBeCloseTo(1, 15);
  });
  it('midpoint in 2D and 3D, without overflow near the float limit', () => {
    expect(midpoint([0, 0], [4, 2])).toEqual([2, 1]);
    expect(midpoint([1, 2, 3], [3, 4, 5])).toEqual([2, 3, 4]);
    expect(midpoint([Number.MAX_VALUE, 0], [Number.MAX_VALUE, 0])).toEqual([Number.MAX_VALUE, 0]);
    expect(Object.is(midpoint([-1, 0], [1, 0])[0], 0)).toBe(true);
  });
  it('refuses to mix dimensions or take non-finite coordinates', () => {
    expect(() => distance([0, 0], [0, 0, 0] as unknown as readonly [number, number])).toThrow(InvalidArgumentError);
    expect(() => distance([0, Number.NaN], [0, 0])).toThrow(InvalidArgumentError);
  });
  it('signed shoelace area is positive counterclockwise and negative clockwise', () => {
    const ccw = [
      [0, 0],
      [4, 0],
      [4, 3],
      [0, 3],
    ] as const;
    const cw = [
      [0, 3],
      [4, 3],
      [4, 0],
      [0, 0],
    ] as const;
    expect(signedPolygonArea(ccw)).toBe(12);
    expect(signedPolygonArea(cw)).toBe(-12);
    expect(polygonArea(cw)).toBe(12);
  });
  it('handles concave polygons and polygons far from the origin', () => {
    // An L shape: 2×2 square minus a 1×1 corner = 3.
    expect(
      polygonArea([
        [0, 0],
        [2, 0],
        [2, 1],
        [1, 1],
        [1, 2],
        [0, 2],
      ]),
    ).toBe(3);
    const far = 1e9;
    expect(
      polygonArea([
        [far, far],
        [far + 0.5, far],
        [far + 0.5, far + 0.5],
        [far, far + 0.5],
      ]),
    ).toBe(0.25);
  });
  it('a repeated closing vertex changes nothing; fewer than three vertices is not a polygon', () => {
    expect(
      polygonArea([
        [0, 0],
        [1, 0],
        [0, 1],
        [0, 0],
      ]),
    ).toBe(0.5);
    expect(() =>
      polygonArea([
        [0, 0],
        [1, 1],
      ]),
    ).toThrow(InvalidArgumentError);
  });
});

describe('Pythagorean triples', () => {
  it('recognises triples in any order, for numbers and bigints', () => {
    expect(isPythagoreanTriple(3, 4, 5)).toBe(true);
    expect(isPythagoreanTriple(13, 5, 12)).toBe(true);
    expect(isPythagoreanTriple(20n, 21n, 29n)).toBe(true);
    expect(isPythagoreanTriple(2, 3, 4)).toBe(false);
  });
  it('is exact where float squares would round to a false positive', () => {
    // 2^53 squared is exact, but (2^53)² + 1 is not representable as a float:
    // in floats, a² + b² === c² would wrongly hold for (1, 2^53, 2^53).
    const big = 2 ** 53;
    expect(big * big + 1 === big * big).toBe(true);
    expect(isPythagoreanTriple(1, big, big)).toBe(false);
    // A real large triple: Euclid with m = 2^26, n = 1.
    const m = 2n ** 26n;
    expect(isPythagoreanTriple(m * m - 1n, 2n * m, m * m + 1n)).toBe(true);
  });
  it('treats non-integers and non-positive sides as not triples, and refuses mixed types', () => {
    expect(isPythagoreanTriple(1.5, 2, 2.5)).toBe(false);
    expect(isPythagoreanTriple(0, 0, 0)).toBe(false);
    expect(isPythagoreanTriple(-3, 4, 5)).toBe(false);
    expect(() => isPythagoreanTriple(3, 4n as unknown as number, 5)).toThrow(TypeError);
  });
  it('lists every triple with c ≤ 30 (primitive and multiples), sorted by c then a', () => {
    expect(pythagoreanTriples(30)).toEqual([
      [3, 4, 5],
      [6, 8, 10],
      [5, 12, 13],
      [9, 12, 15],
      [8, 15, 17],
      [12, 16, 20],
      [7, 24, 25],
      [15, 20, 25],
      [10, 24, 26],
      [20, 21, 29],
      [18, 24, 30],
    ]);
  });
  it('finds the 16 primitive triples with c ≤ 100 (OEIS A020882 terms ≤ 100)', () => {
    const primitive = pythagoreanTriples(100, { primitive: true });
    expect(primitive).toHaveLength(16);
    expect(primitive.map(t => t[2])).toEqual([5, 13, 17, 25, 29, 37, 41, 53, 61, 65, 65, 73, 85, 85, 89, 97]);
    for (const [a, b, c] of pythagoreanTriples(500)) expect(isPythagoreanTriple(a, b, c)).toBe(true);
  });
  it('handles empty limits and rejects bad ones', () => {
    expect(pythagoreanTriples(4)).toEqual([]);
    expect(pythagoreanTriples(0)).toEqual([]);
    expect(() => pythagoreanTriples(-1)).toThrow(InvalidArgumentError);
    expect(() => pythagoreanTriples(10.5)).toThrow(InvalidArgumentError);
  });
});
