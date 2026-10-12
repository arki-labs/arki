import { describe, expect, it } from 'vitest';

import {
  DivisionByZeroError,
  InvalidArgumentError,
  NumericRangeError,
  ResourceLimitError,
} from './errors.js';
import {
  combinations,
  digitSum,
  divisors,
  divmod,
  factorial,
  fibonacci,
  gcd,
  isEven,
  isOdd,
  isPrime,
  lcm,
  modInverse,
  modPow,
  permutations,
  primeFactors,
} from './integer.js';

describe('gcd', () => {
  it('works on numbers', () => {
    expect(gcd(12, 18)).toBe(6);
    expect(gcd(0, 0)).toBe(0);
    expect(gcd(-4, 6)).toBe(2);
    expect(gcd(0, 5)).toBe(5);
    expect(gcd(7, 13)).toBe(1);
  });
  it('works on bigints', () => {
    expect(gcd(12n, 18n)).toBe(6n);
    expect(gcd(-4n, -6n)).toBe(2n);
    expect(gcd(0n, 0n)).toBe(0n);
  });
  it('rejects non-integers and unsafe integers', () => {
    expect(() => gcd(1.5, 3)).toThrow(InvalidArgumentError);
    expect(() => gcd(2 ** 53, 3)).toThrow(InvalidArgumentError);
    expect(() => gcd(Number.NaN, 3)).toThrow(InvalidArgumentError);
  });
  it('refuses to mix number and bigint', () => {
    // @ts-expect-error mixing kinds is a type error too
    expect(() => gcd(1, 2n)).toThrow(TypeError);
  });
});

describe('lcm', () => {
  it('works on numbers', () => {
    expect(lcm(4, 6)).toBe(12);
    expect(lcm(0, 5)).toBe(0);
    expect(lcm(-4, 6)).toBe(12);
    expect(Object.is(lcm(0, -5), 0)).toBe(true);
  });
  it('works on bigints', () => {
    expect(lcm(2n ** 40n, 3n)).toBe(3n * 2n ** 40n);
    expect(lcm(0n, 3n)).toBe(0n);
    expect(lcm(-4n, 6n)).toBe(12n);
  });
  it('throws when the number result is not a safe integer', () => {
    expect(() => lcm(2 ** 40, 2 ** 40 - 1)).toThrow(NumericRangeError);
  });
  it('validates inputs even when one is zero', () => {
    expect(() => lcm(0, 1.5)).toThrow(InvalidArgumentError);
  });
  it('refuses to mix kinds', () => {
    // @ts-expect-error mixing kinds is a type error too
    expect(() => lcm(1n, 2)).toThrow(TypeError);
  });
});

describe('divmod', () => {
  it('floors the quotient; remainder takes the divisor sign', () => {
    expect(divmod(-7, 2)).toEqual([-4, 1]);
    expect(divmod(7, -2)).toEqual([-4, -1]);
    expect(divmod(7, 2)).toEqual([3, 1]);
    expect(divmod(-7, -2)).toEqual([3, -1]);
    expect(divmod(-7n, 2n)).toEqual([-4n, 1n]);
    expect(divmod(7n, -2n)).toEqual([-4n, -1n]);
  });
  it('never returns -0', () => {
    const [q, r] = divmod(0, -5);
    expect(Object.is(q, 0)).toBe(true);
    expect(Object.is(r, 0)).toBe(true);
    const [q2, r2] = divmod(-6, 3);
    expect(Object.is(q2, -2)).toBe(true);
    expect(Object.is(r2, 0)).toBe(true);
  });
  it('throws on a zero divisor', () => {
    expect(() => divmod(1, 0)).toThrow(DivisionByZeroError);
    expect(() => divmod(1n, 0n)).toThrow(DivisionByZeroError);
  });
  it('rejects non-integers', () => {
    expect(() => divmod(1.5, 2)).toThrow(InvalidArgumentError);
  });
});

describe('divmod with huge safe integers', () => {
  const MAX = Number.MAX_SAFE_INTEGER;

  it('keeps the remainder exact when quotient * b would be unsafe', () => {
    expect(divmod(-MAX, 4_503_599_627_370_495)).toEqual([-3, 4_503_599_627_370_494]);
  });

  it('handles every sign combination at large magnitude', () => {
    expect(divmod(MAX, 4_503_599_627_370_495)).toEqual([2, 1]);
    expect(divmod(MAX, -4_503_599_627_370_495)).toEqual([-3, -4_503_599_627_370_494]);
    expect(divmod(-MAX, -4_503_599_627_370_495)).toEqual([2, -1]);
  });

  it('matches the bigint overload on 200 pseudo-random cases', () => {
    let seed = 12_345;
    const next = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    for (let i = 0; i < 200; i++) {
      const a = Math.trunc((next() * 2 - 1) * MAX);
      let b = Math.trunc((next() * 2 - 1) * (i % 2 === 0 ? MAX : 1e6));
      if (b === 0) b = 3;
      const [q, r] = divmod(a, b);
      const [bq, br] = divmod(BigInt(a), BigInt(b));
      expect([BigInt(q), BigInt(r)]).toEqual([bq, br]);
    }
  });
});

describe('factorial', () => {
  it('computes known values', () => {
    expect(factorial(0)).toBe(1);
    expect(factorial(5)).toBe(120);
    expect(factorial(18)).toBe(6_402_373_705_728_000);
    expect(factorial(25n)).toBe(15_511_210_043_330_985_984_000_000n);
    expect(factorial(0n)).toBe(1n);
  });
  it('refuses unsafe results and bad input', () => {
    expect(() => factorial(19)).toThrow(NumericRangeError);
    expect(() => factorial(-1)).toThrow(InvalidArgumentError);
    expect(() => factorial(-1n)).toThrow(InvalidArgumentError);
    expect(() => factorial(1.5)).toThrow(InvalidArgumentError);
    expect(() => factorial(3249n)).toThrow(ResourceLimitError); // 3249! is the first past 10,000 digits
    expect(factorial(3248n).toString().length).toBe(9998);
  });
});

describe('combinations', () => {
  it('computes known values', () => {
    expect(combinations(52, 5)).toBe(2_598_960);
    expect(combinations(5, 0)).toBe(1);
    expect(combinations(5, 5)).toBe(1);
    expect(combinations(100n, 50n)).toBe(100_891_344_545_564_193_334_812_497_256n);
  });
  it('is zero outside 0..k', () => {
    expect(combinations(5, 6)).toBe(0);
    expect(combinations(5, -1)).toBe(0);
    expect(combinations(5n, 6n)).toBe(0n);
  });
  it('rejects bad input and unsafe results', () => {
    expect(() => combinations(-1, 0)).toThrow(InvalidArgumentError);
    expect(() => combinations(-1n, 0n)).toThrow(InvalidArgumentError);
    expect(() => combinations(100, 50)).toThrow(NumericRangeError);
    expect(() => combinations(5, 2n as never)).toThrow(TypeError);
    expect(() => combinations(100_000n, 50_000n)).toThrow(ResourceLimitError);
  });
  it('number and bigint forms agree on 500 pseudo-random cases', () => {
    let seed = 12_345;
    const next = (max: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % max;
    };
    let safe = 0;
    let unsafe = 0;
    for (let i = 0; i < 500; i++) {
      const n = next(70);
      const k = next(n + 5) - 2;
      const exact = combinations(BigInt(n), BigInt(k));
      if (exact <= BigInt(Number.MAX_SAFE_INTEGER)) {
        expect(combinations(n, k)).toBe(Number(exact));
        safe++;
      } else {
        expect(() => combinations(n, k)).toThrow(NumericRangeError);
        unsafe++;
      }
    }
    expect(safe).toBeGreaterThan(100);
    expect(unsafe).toBeGreaterThan(0);
  });
});

describe('permutations', () => {
  it('computes known values', () => {
    expect(permutations(5, 2)).toBe(20);
    expect(permutations(5, 0)).toBe(1);
    expect(permutations(5, 5)).toBe(120);
    expect(permutations(5, 6)).toBe(0);
    expect(permutations(20n, 20n)).toBe(2_432_902_008_176_640_000n);
  });
  it('rejects bad input and unsafe results', () => {
    expect(() => permutations(-1, 0)).toThrow(InvalidArgumentError);
    expect(() => permutations(-1n, 0n)).toThrow(InvalidArgumentError);
    expect(() => permutations(30, 20)).toThrow(NumericRangeError);
    expect(() => permutations(20_000n, 10_001n)).toThrow(ResourceLimitError);
  });
});

describe('isPrime', () => {
  it('classifies small numbers', () => {
    expect(isPrime(-7)).toBe(false);
    expect(isPrime(0)).toBe(false);
    expect(isPrime(1)).toBe(false);
    for (const p of [2, 3, 97, 1_000_000_007]) expect(isPrime(p)).toBe(true);
    expect(isPrime(4)).toBe(false);
  });
  it('rejects Carmichael numbers', () => {
    expect(isPrime(561)).toBe(false);
    expect(isPrime(3_215_031_751)).toBe(false); // strong pseudoprime to bases 2, 3, 5, 7
  });
  it('is exact at the top of the safe range and the 64-bit range', () => {
    expect(isPrime(9_007_199_254_740_881)).toBe(true);
    expect(isPrime(9_007_199_254_740_881 - 2)).toBe(false);
    expect(isPrime(18_446_744_073_709_551_557n)).toBe(true);
    expect(isPrime(18_446_744_073_709_551_556n)).toBe(false);
  });
  it('refuses n >= 2^64 and unsafe numbers', () => {
    expect(() => isPrime(2n ** 64n)).toThrow(NumericRangeError);
    expect(() => isPrime(2 ** 60)).toThrow(InvalidArgumentError);
    expect(isPrime(-(2n ** 70n))).toBe(false);
  });
});

describe('primeFactors', () => {
  it('factors with multiplicity, ascending', () => {
    expect(primeFactors(360)).toEqual([2, 2, 2, 3, 3, 5]);
    expect(primeFactors(600_851_475_143)).toEqual([71, 839, 1471, 6857]);
    expect(primeFactors(1)).toEqual([]);
    expect(primeFactors(0)).toEqual([]);
    expect(primeFactors(9_007_199_254_740_881)).toEqual([9_007_199_254_740_881]);
  });
  it('handles bigint, Mersenne primes and large semiprimes', () => {
    expect(primeFactors(2n ** 61n - 1n)).toEqual([2_305_843_009_213_693_951n]);
    expect(primeFactors(1_000_000_007n * 998_244_353n)).toEqual([998_244_353n, 1_000_000_007n]);
    expect(primeFactors(2n ** 62n)).toEqual(Array.from({ length: 62 }, () => 2n));
    const p = 4_294_967_291n; // largest prime below 2^32
    expect(primeFactors(p * p)).toEqual([p, p]);
  });
  it('rejects negatives and out-of-range values', () => {
    expect(() => primeFactors(-4)).toThrow(InvalidArgumentError);
    expect(() => primeFactors(-4n)).toThrow(InvalidArgumentError);
    expect(() => primeFactors(10n ** 39n + 1n)).toThrow(NumericRangeError);
  });
});

describe('divisors', () => {
  it('lists divisors ascending', () => {
    expect(divisors(28)).toEqual([1, 2, 4, 7, 14, 28]);
    expect(divisors(1)).toEqual([1]);
    expect(divisors(97)).toEqual([1, 97]);
    expect(divisors(36n)).toEqual([1n, 2n, 3n, 4n, 6n, 9n, 12n, 18n, 36n]);
  });
  it('rejects n < 1', () => {
    expect(() => divisors(0)).toThrow(InvalidArgumentError);
    expect(() => divisors(-6n)).toThrow(InvalidArgumentError);
  });
});

describe('modPow and modInverse', () => {
  it('computes modular powers', () => {
    expect(modPow(2n, 10n, 1000n)).toBe(24n);
    expect(modPow(5n, 0n, 7n)).toBe(1n);
    expect(modPow(5n, 3n, 1n)).toBe(0n);
    expect(modPow(-2n, 3n, 7n)).toBe(6n);
  });
  it('rejects bad arguments', () => {
    expect(() => modPow(2n, -1n, 7n)).toThrow(InvalidArgumentError);
    expect(() => modPow(2n, 1n, 0n)).toThrow(InvalidArgumentError);
    expect(() => modInverse(3n, 0n)).toThrow(InvalidArgumentError);
  });
  it('finds inverses', () => {
    expect(modInverse(3n, 11n)).toBe(4n);
    expect(modInverse(-3n, 11n)).toBe(7n);
    const m = 1_000_000_007n;
    expect((modInverse(123_456_789n, m) * 123_456_789n) % m).toBe(1n);
  });
  it('throws when no inverse exists', () => {
    expect(() => modInverse(4n, 8n)).toThrow(InvalidArgumentError);
    expect(() => modInverse(0n, 5n)).toThrow(InvalidArgumentError);
  });
});

describe('isEven, isOdd, digitSum', () => {
  it('checks parity', () => {
    expect(isEven(0)).toBe(true);
    expect(isEven(-4)).toBe(true);
    expect(isOdd(-3)).toBe(true);
    expect(isOdd(3n)).toBe(true);
    expect(isEven(3n)).toBe(false);
    expect(() => isEven(1.5)).toThrow(InvalidArgumentError);
  });
  it('sums digits of the absolute value', () => {
    expect(digitSum(0)).toBe(0);
    expect(digitSum(-123)).toBe(6);
    expect(digitSum(2n ** 100n)).toBe(115);
    expect(() => digitSum(1.5)).toThrow(InvalidArgumentError);
  });
});

describe('fibonacci', () => {
  it('computes known values', () => {
    expect(fibonacci(0)).toBe(0n);
    expect(fibonacci(1)).toBe(1n);
    expect(fibonacci(10)).toBe(55n);
    expect(fibonacci(90)).toBe(2_880_067_194_370_816_120n);
    expect(fibonacci(1000).toString().length).toBe(209);
  });
  it('rejects bad input', () => {
    expect(() => fibonacci(-1)).toThrow(InvalidArgumentError);
    expect(() => fibonacci(1.5)).toThrow(InvalidArgumentError);
    expect(() => fibonacci(47_852)).toThrow(ResourceLimitError);
    expect(fibonacci(47_851).toString().length).toBe(10_000);
    expect(() => combinations(10n ** 1000n, 100n)).toThrow(ResourceLimitError);
    expect(() => permutations(10n ** 1000n, 100n)).toThrow(ResourceLimitError);
    expect(() => modPow(2n, undefined as never, 7n)).toThrow(TypeError);
  });
});
