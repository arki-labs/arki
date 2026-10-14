import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { fromBase, gcd, isPrime, lcm, primeFactors, toBase } from './integer.js';

// Seeded, so every run checks the same cases and a failure prints a replayable seed and path.
// For a deep run raise the case count: MATH_PROPERTY_RUNS=20000 bun run test.
// The package compiles without Node types (it runs on every runtime); the test runner is Node.
declare const process: { readonly env: Readonly<Record<string, string | undefined>> };
const RUNS = Math.max(500, Number(process.env.MATH_PROPERTY_RUNS) || 0);
const config = { seed: 20_261_014, numRuns: RUNS };

const abs = (x: bigint): bigint => (x < 0n ? -x : x);

const bigArb = fc.oneof(fc.bigInt({ min: -100n, max: 100n }), fc.bigInt({ min: -(10n ** 40n), max: 10n ** 40n }));
const safeArb = fc.oneof(fc.integer({ min: -1000, max: 1000 }), fc.maxSafeInteger());

/** Primality by trial division: slow, obviously right. */
function isPrimeByTrialDivision(n: number): boolean {
  if (n < 2) return false;
  for (let d = 2; d * d <= n; d++) if (n % d === 0) return false;
  return true;
}

describe('integer properties: gcd and lcm', () => {
  it('gcd divides both arguments, and gcd · lcm = |a · b| (bigint)', () => {
    fc.assert(
      fc.property(bigArb, bigArb, (a, b) => {
        const g = gcd(a, b);
        expect(g >= 0n).toBe(true);
        expect(gcd(b, a)).toBe(g);
        if (g === 0n) {
          expect(a === 0n && b === 0n).toBe(true);
          return;
        }
        expect(a % g).toBe(0n);
        expect(b % g).toBe(0n);
        // Greatest: the cofactors share no further divisor.
        expect(gcd(a / g, b / g)).toBe(1n);
        expect(g * lcm(a, b)).toBe(abs(a * b));
      }),
      config,
    );
  });

  it('number and bigint gcd agree on safe integers', () => {
    fc.assert(
      fc.property(safeArb, safeArb, (a, b) => {
        expect(BigInt(gcd(a, b))).toBe(gcd(BigInt(a), BigInt(b)));
      }),
      config,
    );
  });
});

describe('integer properties: toBase / fromBase', () => {
  it('fromBase(toBase(x, base), base) gives x back, for bigints of any size', () => {
    fc.assert(
      fc.property(bigArb, fc.integer({ min: 2, max: 36 }), (value, base) => {
        const text = toBase(value, base);
        expect(fromBase(text, base)).toBe(value);
        expect(fromBase(text.toUpperCase(), base)).toBe(value);
      }),
      config,
    );
  });

  it('round trips safe numbers too', () => {
    fc.assert(
      fc.property(safeArb, fc.integer({ min: 2, max: 36 }), (value, base) => {
        expect(fromBase(toBase(value, base), base)).toBe(BigInt(value));
      }),
      config,
    );
  });
});

describe('integer properties: primes', () => {
  it('isPrime matches trial division below 1e6, for number and bigint', () => {
    fc.assert(
      fc.property(fc.integer({ min: -10, max: 999_999 }), n => {
        const expected = isPrimeByTrialDivision(n);
        expect(isPrime(n)).toBe(expected);
        expect(isPrime(BigInt(n))).toBe(expected);
      }),
      { ...config, numRuns: RUNS * 4 },
    );
  });

  it('primeFactors are ascending primes whose product is the input', () => {
    fc.assert(
      fc.property(fc.oneof(fc.integer({ min: 0, max: 1_000_000 }), fc.maxSafeNat()), n => {
        const factors = primeFactors(n);
        expect(factors.reduce((product, p) => product * p, 1)).toBe(n < 2 ? 1 : n);
        for (const [index, p] of factors.entries()) {
          expect(isPrime(p)).toBe(true);
          if (index > 0) expect(p >= (factors[index - 1] ?? 0)).toBe(true);
        }
      }),
      config,
    );
  });

  it('primeFactors handles bigints up to 2^64 (Pollard–Brent path)', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 2n, max: 2n ** 64n - 1n }), n => {
        const factors = primeFactors(n);
        expect(factors.reduce((product, p) => product * p, 1n)).toBe(n);
        for (const p of factors) expect(isPrime(p)).toBe(true);
      }),
      { ...config, numRuns: Math.ceil(RUNS / 5) },
    );
    // About 6 ms per 64-bit input (worst seen 14 ms): give deep runs room.
  }, 600_000);
});
