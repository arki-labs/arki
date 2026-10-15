/**
 * Factoring over ℚ (RFC §8.2, decision 7): Zassenhaus's algorithm on a
 * square-free primitive polynomial in ℤ[x].
 *
 * 1. Choose a prime p that keeps the polynomial square-free mod p, among up
 *    to 5 such primes the one with the fewest modular factors.
 * 2. Factor mod p: distinct-degree factorization, then Cantor–Zassenhaus
 *    equal-degree splitting with a fixed-seed generator (reproducible).
 * 3. Hensel-lift the factors (a balanced factor tree, quadratic steps) to
 *    p^k > 2·|lc|·B, B the Landau–Mignotte bound on any factor's coefficients.
 * 4. Recombine: products of 1, 2, … lifted factors, kept when their
 *    primitive part divides the polynomial over ℤ.
 *
 * Arithmetic mod p uses numbers (p < 2^15, so products stay exact); lifting
 * and the integer checks use bigint. Every factor returned is proven
 * irreducible; a budget that runs out throws instead.
 *
 * Internal module.
 */
import { isPrime } from '@arki/math/integer';
import { createRandom } from '@arki/math/random';

import type { Budget } from './core.js';

/** Ascending integer coefficients, no trailing zeros. */
export type Zx = bigint[];
/** Ascending coefficients in [0, p), no trailing zeros. */
type Fp = number[];

const CANDIDATE_PRIMES = 5;
const PRIME_LIMIT = 1 << 15;
const SEED = 20_261_015;

// ---------- ℤ/p[x] ----------

function trim<T extends number | bigint>(a: T[]): T[] {
  let n = a.length;
  while (n > 0 && (a[n - 1] === 0 || a[n - 1] === 0n)) n--;
  a.length = n;
  return a;
}

function mod(n: number, p: number): number {
  const r = n % p;
  return r < 0 ? r + p : r;
}

function inverse(a: number, p: number): number {
  let [r0, r1, s0, s1] = [mod(a, p), p, 1, 0];
  while (r1 !== 0) {
    const q = Math.floor(r0 / r1);
    [r0, r1, s0, s1] = [r1, r0 - q * r1, s1, s0 - q * s1];
  }
  if (r0 !== 1) throw new Error('cas invariant: inverting a multiple of p');
  return mod(s0, p);
}

function fpSub(a: Fp, b: Fp, p: number): Fp {
  const out = Array.from({ length: Math.max(a.length, b.length) }, (_, i) => mod((a[i] ?? 0) - (b[i] ?? 0), p));
  return trim(out);
}

function fpMul(a: Fp, b: Fp, p: number, budget: Budget): Fp {
  if (a.length === 0 || b.length === 0) return [];
  budget.spend(Math.ceil((a.length * b.length) / 64));
  const out = Array.from<number>({ length: a.length + b.length - 1 }).fill(0);
  for (const [i, x] of a.entries()) {
    if (x === 0) continue;
    for (const [j, y] of b.entries()) out[i + j] = ((out[i + j] ?? 0) + x * y) % p;
  }
  return trim(out);
}

/** a = q·b + r with deg r < deg b; b non-zero. */
function fpDivmod(a: Fp, b: Fp, p: number): [Fp, Fp] {
  const r = [...a];
  const lead = inverse(b.at(-1) ?? 0, p);
  const q = Array.from<number>({ length: Math.max(0, a.length - b.length + 1) }).fill(0);
  for (let i = r.length - b.length; i >= 0; i--) {
    const c = ((r[i + b.length - 1] ?? 0) * lead) % p;
    q[i] = c;
    if (c === 0) continue;
    for (const [j, y] of b.entries()) r[i + j] = mod((r[i + j] ?? 0) - c * y, p);
  }
  return [trim(q), trim(r)];
}

function fpMonic(a: Fp, p: number): Fp {
  const lead = inverse(a.at(-1) ?? 0, p);
  return a.map(c => (c * lead) % p);
}

function fpGcd(a: Fp, b: Fp, p: number): Fp {
  let [x, y] = [a, b];
  while (y.length > 0) [x, y] = [y, fpDivmod(x, y, p)[1]];
  return x.length === 0 ? x : fpMonic(x, p);
}

/** base^e mod (f, p), e ≥ 0. */
function fpPowMod(base: Fp, e: bigint, f: Fp, p: number, budget: Budget): Fp {
  let result: Fp = [1];
  let b = fpDivmod(base, f, p)[1];
  for (let k = e; k > 0n; k >>= 1n) {
    if (k & 1n) result = fpDivmod(fpMul(result, b, p, budget), f, p)[1];
    b = fpDivmod(fpMul(b, b, p, budget), f, p)[1];
  }
  return result;
}

/** s·a + t·b = 1 mod p for coprime monic-or-not a, b; deg s < deg b, deg t < deg a. */
function fpBezout(a: Fp, b: Fp, p: number, budget: Budget): [Fp, Fp] {
  let [r0, r1] = [a, b];
  let [s0, s1]: [Fp, Fp] = [[1], []];
  let [t0, t1]: [Fp, Fp] = [[], [1]];
  while (r1.length > 0) {
    const [q, r] = fpDivmod(r0, r1, p);
    [r0, r1] = [r1, r];
    [s0, s1] = [s1, fpSub(s0, fpMul(q, s1, p, budget), p)];
    [t0, t1] = [t1, fpSub(t0, fpMul(q, t1, p, budget), p)];
  }
  const unit = inverse(r0[0] ?? 0, p);
  if (r0.length !== 1) throw new Error('cas invariant: Bezout of non-coprime factors');
  return [s0.map(c => (c * unit) % p), t0.map(c => (c * unit) % p)];
}

function fpDerivative(a: Fp, p: number): Fp {
  return trim(a.slice(1).map((c, i) => ((i + 1) * c) % p));
}

/** Distinct-degree factorization of a monic square-free f: [product of the degree-d factors, d]. */
function distinctDegree(f: Fp, p: number, budget: Budget): [Fp, number][] {
  const out: [Fp, number][] = [];
  let rest = f;
  let h: Fp = [0, 1];
  for (let d = 1; 2 * d <= rest.length - 1; d++) {
    h = fpPowMod(h, BigInt(p), rest, p, budget);
    const g = fpGcd(fpSub(h, [0, 1], p), rest, p);
    if (g.length > 1) {
      out.push([g, d]);
      rest = fpDivmod(rest, g, p)[0];
      h = fpDivmod(h, rest, p)[1];
    }
  }
  if (rest.length > 1) out.push([rest, rest.length - 1]);
  return out;
}

/** Cantor–Zassenhaus: split a monic product of degree-d irreducibles (p odd). */
function equalDegree(g: Fp, d: number, p: number, next: (max: number) => number, budget: Budget): Fp[] {
  const n = g.length - 1;
  if (n === d) return [g];
  const exponent = (BigInt(p) ** BigInt(d) - 1n) / 2n;
  for (;;) {
    const a = trim(Array.from({ length: n }, () => next(p - 1)));
    if (a.length < 2) continue;
    const b = fpSub(fpPowMod(a, exponent, g, p, budget), [1], p);
    const h = fpGcd(b, g, p);
    if (h.length > 1 && h.length < g.length) {
      return [...equalDegree(h, d, p, next, budget), ...equalDegree(fpDivmod(g, h, p)[0], d, p, next, budget)];
    }
  }
}

// ---------- ℤ[x] and ℤ/m[x] ----------

function toFp(f: Zx, p: number): Fp {
  const q = BigInt(p);
  return trim(f.map(c => Number(((c % q) + q) % q)));
}

function zMod(a: Zx, m: bigint): Zx {
  return trim(a.map(c => ((c % m) + m) % m));
}

function zAdd(a: Zx, b: Zx): Zx {
  return trim(Array.from({ length: Math.max(a.length, b.length) }, (_, i) => (a[i] ?? 0n) + (b[i] ?? 0n)));
}

function zSub(a: Zx, b: Zx): Zx {
  return trim(Array.from({ length: Math.max(a.length, b.length) }, (_, i) => (a[i] ?? 0n) - (b[i] ?? 0n)));
}

/** 64-bit words of the largest coefficient: bigint work grows with it, so fuel does too. */
function words(f: Zx): number {
  let top = 0n;
  for (const c of f) top = maxBig(top, abs(c));
  return Math.ceil(top.toString(16).length / 16);
}

function zMul(a: Zx, b: Zx, budget: Budget): Zx {
  if (a.length === 0 || b.length === 0) return [];
  budget.spend(Math.ceil((a.length * b.length * (1 + (words(a) * words(b)) / 64)) / 16));
  const out = Array.from<bigint>({ length: a.length + b.length - 1 }).fill(0n);
  for (const [i, x] of a.entries()) {
    if (x === 0n) continue;
    for (const [j, y] of b.entries()) out[i + j] = (out[i + j] ?? 0n) + x * y;
  }
  return trim(out);
}

/** a = q·b + r mod m for a monic b. */
function zDivmodMonic(a: Zx, b: Zx, m: bigint): [Zx, Zx] {
  const r = zMod(a, m);
  const q = Array.from<bigint>({ length: Math.max(0, r.length - b.length + 1) }).fill(0n);
  for (let i = r.length - b.length; i >= 0; i--) {
    const c = r[i + b.length - 1] ?? 0n;
    q[i] = c;
    if (c === 0n) continue;
    for (const [j, y] of b.entries()) r[i + j] = ((r[i + j] ?? 0n) - c * y) % m;
  }
  return [zMod(q, m), zMod(r, m)];
}

/**
 * One quadratic Hensel step (von zur Gathen–Gerhard 15.10): from
 * f ≡ g·h, s·g + t·h ≡ 1 (mod m), h monic, to the same mod m².
 */
function henselStep(f: Zx, g: Zx, h: Zx, s: Zx, t: Zx, m: bigint, budget: Budget): [Zx, Zx, Zx, Zx] {
  const m2 = m * m;
  const e = zMod(zSub(f, zMul(g, h, budget)), m2);
  const [q, r] = zDivmodMonic(zMul(s, e, budget), h, m2);
  const g2 = zMod(zAdd(g, zAdd(zMul(t, e, budget), zMul(q, g, budget))), m2);
  const h2 = zMod(zAdd(h, r), m2);
  const b = zMod(zSub(zAdd(zMul(s, g2, budget), zMul(t, h2, budget)), [1n]), m2);
  const [c, d] = zDivmodMonic(zMul(s, b, budget), h2, m2);
  const s2 = zMod(zSub(s, d), m2);
  const t2 = zMod(zSub(t, zAdd(zMul(t, b, budget), zMul(c, g2, budget))), m2);
  return [g2, h2, s2, t2];
}

function fpProduct(factors: readonly Fp[], p: number, budget: Budget): Fp {
  return factors.reduce<Fp>((acc, u) => fpMul(acc, u, p, budget), [1]);
}

/**
 * Lifts f ≡ lc·∏ us (mod p), us monic, to monic factors mod `target`
 * (= p^(2^steps)) through a balanced factor tree.
 */
function lift(f: Zx, us: readonly Fp[], p: number, steps: number, budget: Budget): Zx[] {
  const target = BigInt(p) ** (1n << BigInt(steps));
  if (us.length === 1) {
    const lead = f.at(-1) ?? 1n;
    const inv = modInverseBig(lead, target);
    return [
      zMod(
        f.map(c => c * inv),
        target,
      ),
    ];
  }
  const half = us.length >> 1;
  const [left, right] = [us.slice(0, half), us.slice(half)];
  const lc = Number((((f.at(-1) ?? 0n) % BigInt(p)) + BigInt(p)) % BigInt(p));
  const g0 = fpMul([lc], fpProduct(left, p, budget), p, budget);
  const h0 = fpProduct(right, p, budget);
  const [s0, t0] = fpBezout(g0, h0, p, budget);
  let [g, h, s, t]: Zx[] = [g0, h0, s0, t0].map(a => a.map(BigInt));
  let m = BigInt(p);
  for (let k = 0; k < steps; k++) {
    [g, h, s, t] = henselStep(f, g ?? [], h ?? [], s ?? [], t ?? [], m, budget);
    m *= m;
  }
  return [...lift(g ?? [], left, p, steps, budget), ...lift(h ?? [], right, p, steps, budget)];
}

function modInverseBig(a: bigint, m: bigint): bigint {
  let [r0, r1, s0, s1] = [((a % m) + m) % m, m, 1n, 0n];
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1, s0, s1] = [r1, r0 - q * r1, s1, s0 - q * s1];
  }
  return ((s0 % m) + m) % m;
}

/** `Math.max` throws on bigints. */
function maxBig(a: bigint, b: bigint): bigint {
  return a < b ? b : a;
}

function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (let y = (x + n / x) / 2n; y < x; y = (x + n / x) / 2n) x = y;
  return x;
}

function binomial(n: number, k: number): bigint {
  let out = 1n;
  for (let i = 1; i <= k; i++) out = (out * BigInt(n - k + i)) / BigInt(i);
  return out;
}

function gcdBig(a: bigint, b: bigint): bigint {
  let [x, y] = [abs(a), abs(b)];
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

/** f divided by the gcd of its coefficients, with a positive leading coefficient. */
export function primitive(f: Zx): Zx {
  const content = f.reduce((g, c) => gcdBig(g, c), 0n);
  const sign = (f.at(-1) ?? 0n) < 0n ? -1n : 1n;
  return content === 0n ? f : f.map(c => (sign * c) / content);
}

/** f / d over ℤ when d divides f exactly, else `undefined`. */
function exactQuotient(f: Zx, d: Zx): Zx | undefined {
  const r = [...f];
  const lead = d.at(-1) ?? 0n;
  const q = Array.from<bigint>({ length: Math.max(0, f.length - d.length + 1) }).fill(0n);
  for (let i = r.length - d.length; i >= 0; i--) {
    const top = r[i + d.length - 1] ?? 0n;
    if (top % lead !== 0n) return undefined;
    const c = top / lead;
    q[i] = c;
    for (const [j, y] of d.entries()) r[i + j] = (r[i + j] ?? 0n) - c * y;
  }
  return trim(r).length === 0 ? trim(q) : undefined;
}

function maxNorm(f: Zx): bigint {
  return f.reduce((m, c) => maxBig(m, abs(c)), 0n);
}

function evaluate(f: Zx, x: bigint, budget: Budget): bigint {
  // The value grows to about deg·log x digits; Horner's steps cost about that each.
  budget.spend(Math.ceil((f.length * f.length * words([x])) / 64));
  let value = 0n;
  for (let i = f.length - 1; i >= 0; i--) value = value * x + (f[i] ?? 0n);
  return value;
}

/** The polynomial whose base-x digits (symmetric, |digit| < x/2) are those of h. */
function interpolate(h: bigint, x: bigint): Zx {
  const out: Zx = [];
  for (let rest = h; rest !== 0n;) {
    let digit = rest % x;
    if (digit > x / 2n) digit -= x;
    else if (digit < -x / 2n) digit += x;
    out.push(digit);
    rest = (rest - digit) / x;
  }
  return out;
}

const HEURISTIC_TRIES = 6;

/**
 * gcd(f, g) over ℤ by the heuristic gcd (GCDHEU, as in SymPy): evaluate at a
 * large integer ξ, take the integer gcd, read it back as base-ξ digits, and
 * keep it only when it divides both exactly. Coefficients never grow the way
 * a remainder sequence's do. `undefined` after 6 failed ξ (rare); callers then
 * use the remainder-sequence gcd.
 */
function heuristicGcd(f: Zx, g: Zx, budget: Budget): Zx | undefined {
  const [nf, ng] = [maxNorm(f), maxNorm(g)];
  const bound = nf < ng ? nf : ng; // eslint-disable-line unicorn/prefer-math-min-max -- bigints: Math.min throws on them
  let x = 2n * bound + 29n;
  for (let i = 0; i < HEURISTIC_TRIES; i++) {
    const [ff, gg] = [evaluate(f, x, budget), evaluate(g, x, budget)];
    if (ff !== 0n && gg !== 0n) {
      const size = words([ff]);
      budget.spend(Math.ceil((size * size) / 64));
      const candidate = primitive(interpolate(gcdBig(ff, gg), x));
      if (
        candidate.length > 0 &&
        exactQuotient(f, candidate) !== undefined &&
        exactQuotient(g, candidate) !== undefined
      ) {
        return candidate;
      }
    }
    x = (73_794n * x * isqrt(isqrt(x))) / 27_011n;
  }
  return undefined;
}

function derivative(f: Zx): Zx {
  return trim(f.slice(1).map((c, i) => BigInt(i + 1) * c));
}

/**
 * Yun's square-free decomposition of a primitive f over ℤ, with heuristic
 * gcds: parts (primitive, positive leading coefficient) with multiplicities,
 * whose product is f. `undefined` when a heuristic gcd gives up.
 */
export function squareFree(f: Zx, budget: Budget): [Zx, number][] | undefined {
  if (squareFreeModP(f, budget)) return [[f, 1]];
  const df = derivative(f);
  const a0 = heuristicGcd(f, df, budget);
  if (a0 === undefined) return undefined;
  let b = exactQuotient(f, a0);
  const c = exactQuotient(df, a0);
  if (b === undefined || c === undefined) throw new Error('cas invariant: a gcd did not divide its input');
  let d = zSub(c, derivative(b));
  const out: [Zx, number][] = [];
  for (let i = 1; b.length > 1; i++) {
    const a = d.length === 0 ? b : heuristicGcd(b, d, budget);
    if (a === undefined) return undefined;
    if (a.length > 1) out.push([primitive(a), i]);
    const nextB = exactQuotient(b, a);
    const nextC = d.length === 0 ? [] : exactQuotient(d, a);
    if (nextB === undefined || nextC === undefined) throw new Error('cas invariant: a gcd did not divide its input');
    b = nextB;
    d = zSub(nextC, derivative(b));
  }
  return out;
}

/**
 * True when f mod p is square-free for one of a few small primes p not
 * dividing lc(f): then f is square-free over ℚ, and no gcd over ℤ is needed.
 * False proves nothing (repeated factors, or unlucky primes).
 */
function squareFreeModP(f: Zx, budget: Budget): boolean {
  let tried = 0;
  for (let p = 3; tried < CANDIDATE_PRIMES && p < PRIME_LIMIT; p += 2) {
    if (!isPrime(p) || (f.at(-1) ?? 0n) % BigInt(p) === 0n) continue;
    tried++;
    budget.spend(f.length);
    const fp = toFp(f, p);
    if (fpGcd(fp, fpDerivative(fp, p), p).length === 1) return true;
  }
  return false;
}

/** A prime keeping f square-free mod p with the fewest modular factors, and those factors. */
function choosePrime(f: Zx, budget: Budget): { p: number; parts: [Fp, number][] } {
  let best: { p: number; parts: [Fp, number][]; count: number } | undefined;
  let tried = 0;
  for (let p = 3; p < PRIME_LIMIT && tried < CANDIDATE_PRIMES; p += 2) {
    if (!isPrime(p) || (f.at(-1) ?? 0n) % BigInt(p) === 0n) continue;
    const fp = fpMonic(toFp(f, p), p);
    if (fpGcd(fp, fpDerivative(fp, p), p).length !== 1) continue;
    tried++;
    const parts = distinctDegree(fp, p, budget);
    const count = parts.reduce((sum, [g, d]) => sum + (g.length - 1) / d, 0);
    if (best === undefined || count < best.count) best = { p, parts, count };
    if (count === 1) break;
  }
  if (best === undefined) throw new Error('cas invariant: no prime keeps a square-free polynomial square-free');
  return best;
}

/**
 * The irreducible factors over ℤ of a square-free primitive f (degree ≥ 1,
 * positive leading coefficient), each primitive with a positive leading
 * coefficient. Their product is f.
 */
export function irreducibleFactors(f: Zx, budget: Budget): Zx[] {
  const n = f.length - 1;
  if (n <= 1) return [f];
  const { p, parts } = choosePrime(f, budget);
  const random = createRandom(SEED);
  const next = (max: number): number => random.int(0, max);
  const modular = parts.flatMap(([g, d]) => equalDegree(g, d, p, next, budget));
  if (modular.length === 1) return [f];
  // Landau–Mignotte: a factor of degree ≤ n − 1 has coefficients ≤ C(n−1, ⌊(n−1)/2⌋)·‖f‖₂.
  const lead = abs(f.at(-1) ?? 1n);
  const norm = isqrt(f.reduce((sum, c) => sum + c * c, 0n)) + 1n;
  const bound = 2n * lead * binomial(n - 1, (n - 1) >> 1) * norm + 1n;
  let steps = 0;
  for (let m = BigInt(p); m <= bound; m *= m) steps++;
  const modulus = BigInt(p) ** (1n << BigInt(steps));
  budget.check('liftDigits', modulus.toString().length);
  const lifted = lift(f, modular, p, steps, budget);
  return recombine(f, lifted, modulus, budget);
}

function symmetric(c: bigint, m: bigint): bigint {
  const r = ((c % m) + m) % m;
  return r > m / 2n ? r - m : r;
}

/** Subsets of size 1, 2, … of the lifted factors whose product (times lc) gives a true factor. */
function recombine(f: Zx, lifted: Zx[], modulus: bigint, budget: Budget): Zx[] {
  const found: Zx[] = [];
  let rest = f;
  let pool = lifted;
  let tested = 0;
  for (let size = 1; 2 * size <= pool.length;) {
    let hit = false;
    for (const subset of subsets(pool.length, size)) {
      budget.check('recombination', ++tested);
      const lead = rest.at(-1) ?? 1n;
      let candidate: Zx = [lead];
      for (const i of subset) candidate = zMod(zMul(candidate, pool[i] ?? [], budget), modulus);
      candidate = trim(candidate.map(c => symmetric(c, modulus)));
      // Constant-term test first: the factor's constant term divides lc·f(0).
      const c0 = candidate[0] ?? 0n;
      if (c0 !== 0n && (lead * (rest[0] ?? 0n)) % c0 !== 0n) continue;
      const factor = primitive(candidate);
      const quotient = exactQuotient(rest, factor);
      if (quotient === undefined) continue;
      found.push(factor);
      rest = quotient;
      pool = pool.filter((_, i) => !subset.includes(i));
      hit = true;
      break;
    }
    if (!hit) size++;
  }
  if (rest.length > 1) found.push(primitive(rest));
  return found;
}

/** Index subsets of {0, …, n−1} of one size, in lexicographic order. */
function* subsets(n: number, size: number): Generator<number[]> {
  const index = Array.from({ length: size }, (_, i) => i);
  for (;;) {
    yield [...index];
    let i = size - 1;
    while (i >= 0 && index[i] === n - size + i) i--;
    if (i < 0) return;
    index[i] = (index[i] ?? 0) + 1;
    for (let j = i + 1; j < size; j++) index[j] = (index[j - 1] ?? 0) + 1;
  }
}
