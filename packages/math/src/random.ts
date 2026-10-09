/**
 * Random numbers that behave the same on every JavaScript runtime.
 *
 * `createRandom()` with no seed draws from the platform's secure generator
 * (`crypto.getRandomValues`) when it exists, and falls back to `Math.random`
 * where it does not. `createRandom(seed)` gives a repeatable stream: the same
 * seed always produces the same numbers, on every runtime. Seeded streams are
 * for tests, games and simulations. They are not secure.
 */

import { EmptyDataError, InvalidArgumentError } from './errors.js';
import { assertFinite } from './number.js';

/** A random-number source with helpers for the common draws. */
export type Random = {
  /** Uniform float in [0, 1), 53 bits of randomness. */
  next(this: void): number;
  /** Uniform integer in [min, max], both ends included. Safe integers only; unbiased (rejection sampling, never `Math.floor(next() * range)` bias). */
  int(this: void, min: number, max: number): number;
  /** Uniform float in [min, max). Defaults to [0, 1). */
  float(this: void, min?: number, max?: number): number;
  /** `true` with the given probability (default 0.5). */
  bool(this: void, probability?: number): boolean;
  /** One element, uniformly. EmptyDataError on empty. */
  pick<T>(this: void, items: readonly T[]): T;
  /** A shuffled copy (Fisher–Yates). Input is never mutated. */
  shuffle<T>(this: void, items: readonly T[]): T[];
  /** `count` distinct elements without replacement, in random order. InvalidArgumentError if count > length or negative. */
  sample<T>(this: void, items: readonly T[], count: number): T[];
  /** Normally distributed value (Box–Muller). */
  gaussian(this: void, mean?: number, stddev?: number): number;
};

/** The only part of the Web Crypto API this module needs. */
type MinimalCrypto = {
  getRandomValues(array: Uint32Array): Uint32Array;
};

const TWO_26 = 2 ** 26;
const TWO_53 = 2 ** 53;
const CRYPTO_CHUNK_WORDS = 256;

/** Reads `globalThis.crypto` without needing DOM or Node typings. */
function findCrypto(): MinimalCrypto | undefined {
  const candidate = (globalThis as { crypto?: Partial<MinimalCrypto> }).crypto;
  if (candidate !== undefined && typeof candidate.getRandomValues === 'function') {
    return candidate as MinimalCrypto;
  }
  return undefined;
}

/** A source of unsigned 32-bit integers. */
type Word32 = () => number;

function cryptoWords(source: MinimalCrypto): Word32 {
  const buffer = new Uint32Array(CRYPTO_CHUNK_WORDS);
  let index = CRYPTO_CHUNK_WORDS;
  return () => {
    if (index >= CRYPTO_CHUNK_WORDS) {
      source.getRandomValues(buffer);
      index = 0;
    }
    return buffer[index++] ?? 0;
  };
}

const mathRandomWord: Word32 = () => Math.floor(Math.random() * 4_294_967_296);

/** cyrb53 string hash: two 32-bit halves of a 53-bit hash. */
function cyrb53(text: string): readonly [number, number] {
  let h1 = 3_735_928_559;
  let h2 = 1_103_547_991;
  for (let i = 0; i < text.length; i++) {
    const ch = text.codePointAt(i) ?? 0;
    h1 = Math.imul(h1 ^ ch, 2_654_435_761);
    h2 = Math.imul(h2 ^ ch, 1_597_334_677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2_246_822_507) ^ Math.imul(h2 ^ (h2 >>> 13), 3_266_489_909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2_246_822_507) ^ Math.imul(h1 ^ (h1 >>> 13), 3_266_489_909);
  return [h1 >>> 0, h2 >>> 0];
}

/** splitmix32: turns one 32-bit seed into a stream of well-mixed words. */
function splitmix32(seed: number): Word32 {
  const state = new Uint32Array([seed]); // typed-array stores wrap to 32 bits for us
  return () => {
    const a = ((state[0] ?? 0) + 2_654_435_769) >>> 0;
    state[0] = a;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 569_420_461);
    t ^= t >>> 15;
    t = Math.imul(t, 1_935_289_751);
    t ^= t >>> 15;
    return (t ^ (t >>> 15)) >>> 0;
  };
}

function rotl(x: number, k: number): number {
  return (x << k) | (x >>> (32 - k));
}

/** xoshiro128**: a small, fast generator with 128 bits of state. */
function xoshiro128ss(seed: number | string): Word32 {
  const [high, low] = cyrb53(String(seed));
  const mix = splitmix32(low);
  const s = new Uint32Array([mix() ^ high, mix(), mix(), mix()]);
  if (s.every(w => w === 0)) s[0] = 1; // the all-zero state is a fixed point
  return () => {
    const s0 = s[0] ?? 0;
    const s1 = s[1] ?? 0;
    const s2 = s[2] ?? 0;
    const s3 = s[3] ?? 0;
    const result = Math.imul(rotl(Math.imul(s1, 5), 7), 9) >>> 0;
    const t = s1 << 9;
    const n2 = s2 ^ s0;
    const n3 = s3 ^ s1;
    s[1] = s1 ^ n2;
    s[0] = s0 ^ n3;
    s[2] = n2 ^ t;
    s[3] = rotl(n3, 11);
    return result;
  };
}

/** Uniform integer in [0, 2^53) from two 32-bit words. */
function draw53(word: Word32): number {
  const hi = word() >>> 5;
  const lo = word() >>> 6;
  return hi * TWO_26 + lo;
}

/** Unbiased integer in [min, max] for spans too wide for exact double arithmetic. */
function wideInt(word: Word32, min: number, max: number): number {
  const bigMin = BigInt(min);
  const count = BigInt(max) - bigMin + 1n;
  const space = 1n << 64n;
  const limit = space - (space % count);
  const shift = 32n;
  for (;;) {
    const r = (BigInt(word()) << shift) | BigInt(word());
    if (r < limit) return Number(bigMin + (r % count));
  }
}

function assertSafeInteger(value: number, name: string): void {
  assertFinite(value, name);
  if (!Number.isSafeInteger(value)) {
    throw new InvalidArgumentError(`${name} must be a safe integer, got ${value}`);
  }
}

function build(word: Word32): Random {
  const next = (): number => draw53(word) / TWO_53;

  const int = (min: number, max: number): number => {
    assertSafeInteger(min, 'min');
    assertSafeInteger(max, 'max');
    if (min > max) throw new InvalidArgumentError(`min (${min}) is greater than max (${max})`);
    const count = max - min + 1;
    if (count > TWO_53 || !Number.isSafeInteger(count)) return wideInt(word, min, max);
    const limit = TWO_53 - (TWO_53 % count);
    for (;;) {
      const r = draw53(word);
      if (r < limit) return min + (r % count);
    }
  };

  const float = (min = 0, max = 1): number => {
    assertFinite(min, 'min');
    assertFinite(max, 'max');
    if (!(min < max)) throw new InvalidArgumentError(`min (${min}) must be less than max (${max})`);
    const t = next();
    const value = min * (1 - t) + max * t;
    return value >= max ? min : value;
  };

  const bool = (probability = 0.5): boolean => {
    assertFinite(probability, 'probability');
    if (probability < 0 || probability > 1) {
      throw new InvalidArgumentError(`probability must be within [0, 1], got ${probability}`);
    }
    return next() < probability;
  };

  const pick = <T>(items: readonly T[]): T => {
    if (items.length === 0) throw new EmptyDataError('cannot pick from an empty array');
    return items[int(0, items.length - 1)] as T;
  };

  const shuffle = <T>(items: readonly T[]): T[] => {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = int(0, i);
      const held = copy[i] as T;
      copy[i] = copy[j] as T;
      copy[j] = held;
    }
    return copy;
  };

  const sample = <T>(items: readonly T[], count: number): T[] => {
    assertSafeInteger(count, 'count');
    if (count < 0) throw new InvalidArgumentError(`count must not be negative, got ${count}`);
    if (count > items.length) {
      throw new InvalidArgumentError(`count (${count}) is greater than the number of items (${items.length})`);
    }
    const copy = [...items];
    for (let i = 0; i < count; i++) {
      const j = int(i, copy.length - 1);
      const held = copy[i] as T;
      copy[i] = copy[j] as T;
      copy[j] = held;
    }
    return copy.slice(0, count);
  };

  const gaussian = (mean = 0, stddev = 1): number => {
    assertFinite(mean, 'mean');
    assertFinite(stddev, 'stddev');
    if (stddev < 0) throw new InvalidArgumentError(`stddev must not be negative, got ${stddev}`);
    const u1 = 1 - next(); // in (0, 1], so the log is finite
    const u2 = next();
    return mean + stddev * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };

  return { next, int, float, bool, pick, shuffle, sample, gaussian };
}

/**
 * Seeded → deterministic xoshiro128** stream (seed via splitmix32; string seeds hashed with cyrb53).
 * Unseeded → crypto-backed when available, `Math.random` otherwise.
 * Numeric seeds must be finite. The number `1` and the string `'1'` give the same stream.
 */
export function createRandom(seed?: number | string): Random {
  if (seed === undefined) {
    const source = findCrypto();
    return build(source === undefined ? mathRandomWord : cryptoWords(source));
  }
  if (typeof seed === 'number') assertFinite(seed, 'seed');
  else if (typeof seed !== 'string') throw new TypeError('seed must be a number or a string');
  return build(xoshiro128ss(seed));
}

/** The default, unseeded generator. */
export const random: Random = createRandom();

/** Uniform integer in [min, max], both ends included, from the default generator. */
export const randomInt: Random['int'] = random.int;

/** Uniform float in [min, max) (default [0, 1)) from the default generator. */
export const randomFloat: Random['float'] = random.float;

/** `true` with the given probability (default 0.5), from the default generator. */
export const randomBool: Random['bool'] = random.bool;

/** One element chosen uniformly by the default generator. Throws `EmptyDataError` on an empty array. */
export const pick: Random['pick'] = random.pick;

/** A shuffled copy of the input, from the default generator. */
export const shuffle: Random['shuffle'] = random.shuffle;

/** `count` distinct elements in random order, from the default generator. */
export const sample: Random['sample'] = random.sample;
