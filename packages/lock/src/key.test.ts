import { lockKeySchema } from './identity-schemas.js';
import { describe, expect, it } from 'vitest';

import { LockError } from './errors.js';
import { createKey, digest64, fnv1a64, fnv1a64Utf8, legacyPgText, toPgPair } from './key.js';
import { keyNameSchema } from './schemas.js';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('fnv1a64', () => {
  // Reference vectors from the FNV test suite.
  it.each([
    ['', 0xCB_F2_9C_E4_84_22_23_25n],
    ['a', 0xAF_63_DC_4C_86_01_EC_8Cn],
    ['foobar', 0x85_94_41_71_F7_39_67_E8n],
  ])('hashes %j', (input, expected) => {
    expect(fnv1a64(bytes(input))).toBe(expected);
  });
});

// Published vectors. If one changes, every Postgres advisory lock key moves:
// two replicas on different versions would stop excluding each other.
const VECTORS = [
  { ns: 'a', name: 'b', full: lockKeySchema.parse('1:1:a:1:b'), digest: 0x27_E5_FB_35_A8_20_2E_BDn, hi: 669_383_477, lo: -1_474_285_891 },
  {
    ns: 'a:b',
    name: 'c',
    full: lockKeySchema.parse('1:3:a:b:1:c'),
    digest: 0x74_00_48_A6_95_6B_CE_D8n,
    hi: 1_946_175_654,
    lo: -1_788_096_808,
  },
  {
    ns: 'a',
    name: 'b:c',
    full: lockKeySchema.parse('1:1:a:3:b:c'),
    digest: 0x97_E2_6A_E3_CF_85_E3_4Cn,
    hi: -1_746_769_181,
    lo: -813_309_108,
  },
  {
    ns: 'avocabo',
    name: 'send-digest',
    full: lockKeySchema.parse('1:7:avocabo:11:send-digest'),
    digest: 0x2F_5B_C3_07_F1_7B_9F_09n,
    hi: 794_542_855,
    lo: -243_556_599,
  },
  {
    ns: 'kapodopera',
    name: 'tracking:usr_1:cnt_2',
    full: lockKeySchema.parse('1:10:kapodopera:20:tracking:usr_1:cnt_2'),
    digest: 0x65_97_87_CE_2C_15_FB_F2n,
    hi: 1_704_429_518,
    lo: 739_638_258,
  },
  {
    ns: 'ns',
    name: 'héllo wörld',
    full: lockKeySchema.parse('1:2:ns:13:héllo wörld'),
    digest: 0xEA_AC_57_EF_15_1C_C8_2En,
    hi: -357_804_049,
    lo: 354_207_790,
  },
  {
    ns: 'ns',
    name: '日本語🔒',
    full: lockKeySchema.parse('1:2:ns:13:日本語🔒'),
    digest: 0x3D_F2_65_4D_8D_0E_A9_F0n,
    hi: 1_039_295_821,
    lo: -1_928_418_832,
  },
  {
    ns: 'xxx',
    name: 'y'.repeat(512),
    full: `1:3:xxx:512:${'y'.repeat(512)}`,
    digest: 0x6D_F0_90_5B_E9_4F_42_DFn,
    hi: 1_844_482_139,
    lo: -380_681_505,
  },
  {
    ns: 'a'.repeat(512),
    name: 'b',
    full: `1:512:${'a'.repeat(512)}:1:b`,
    digest: 0xC1_28_D6_EF_64_44_53_C5n,
    hi: -1_054_288_145,
    lo: 1_682_199_493,
  },
] as const;

describe('createKey vectors', () => {
  it.each(VECTORS)('encodes and hashes $ns / $name', ({ ns, name, full, digest, hi, lo }) => {
    const key = createKey(ns, name);
    expect(key.full).toBe(full);
    expect(digest64(key)).toBe(digest);
    expect(toPgPair(key)).toEqual({ hi, lo });
  });

  it('has at least eight vectors', () => {
    expect(VECTORS.length).toBeGreaterThanOrEqual(8);
  });
});

// One vector set per primitive tag. Mutex vectors above are the ones live apps depend on.
const PRIMITIVE_VECTORS = [
  {
    primitive: 'semaphore',
    ns: 'a',
    name: 'b',
    full: lockKeySchema.parse('1s:1:a:1:b'),
    digest: 0xCF_03_46_7B_85_88_98_FCn,
    hi: -821_868_933,
    lo: -2_054_645_508,
  },
  {
    primitive: 'semaphore',
    ns: 'avocabo',
    name: 'send-digest',
    full: lockKeySchema.parse('1s:7:avocabo:11:send-digest'),
    digest: 0xB2_F5_D6_D6_05_24_8D_52n,
    hi: -1_292_511_530,
    lo: 86_281_554,
  },
  {
    primitive: 'semaphore',
    ns: 'ns',
    name: 'héllo wörld',
    full: lockKeySchema.parse('1s:2:ns:13:héllo wörld'),
    digest: 0x45_72_9A_25_C1_96_16_5Bn,
    hi: 1_165_138_469,
    lo: -1_047_128_485,
  },
  {
    primitive: 'readWrite',
    ns: 'a',
    name: 'b',
    full: lockKeySchema.parse('1rw:1:a:1:b'),
    digest: 0xFD_3D_1D_9F_7A_5C_A1_B2n,
    hi: -46_326_369,
    lo: 2_052_891_058,
  },
  {
    primitive: 'readWrite',
    ns: 'avocabo',
    name: 'send-digest',
    full: lockKeySchema.parse('1rw:7:avocabo:11:send-digest'),
    digest: 0x74_BE_35_7E_07_E0_35_48n,
    hi: 1_958_622_590,
    lo: 132_134_216,
  },
  {
    primitive: 'readWrite',
    ns: 'ns',
    name: 'héllo wörld',
    full: lockKeySchema.parse('1rw:2:ns:13:héllo wörld'),
    digest: 0xB6_81_8E_B9_71_F4_DC_E5n,
    hi: -1_233_023_303,
    lo: 1_911_872_741,
  },
] as const;

describe('createKey vectors per primitive', () => {
  it.each(PRIMITIVE_VECTORS)(
    'encodes and hashes $primitive $ns / $name',
    ({ primitive, ns, name, full, digest, hi, lo }) => {
      const key = createKey(ns, name, primitive);
      expect(key.full).toBe(full);
      expect(digest64(key)).toBe(digest);
      expect(toPgPair(key)).toEqual({ hi, lo });
    },
  );

  it('gives a mutex, a semaphore and a read/write lock of one name three different locks, on every store', () => {
    const keys = [createKey('a', 'b'), createKey('a', 'b', 'semaphore'), createKey('a', 'b', 'readWrite')];
    expect(new Set(keys.map(key => key.full)).size).toBe(3);
    expect(new Set(keys.map(key => digest64(key))).size).toBe(3);
    expect(new Set(keys.map(key => JSON.stringify(toPgPair(key)))).size).toBe(3);
  });

  it('keeps the mutex encoding when no primitive is given, because live apps depend on those digests', () => {
    expect(createKey('a', 'b', 'mutex')).toEqual(createKey('a', 'b'));
    expect(createKey('a', 'b').full).toBe('1:1:a:1:b');
  });
});

describe('createKey', () => {
  it('keeps pairs apart that collide under naive joining', () => {
    const left = createKey('a:b', 'c');
    const right = createKey('a', 'b:c');
    expect(`${left.namespace}:${left.name}`).toBe(`${right.namespace}:${right.name}`);
    expect(left.full).not.toBe(right.full);
    expect(digest64(left)).not.toBe(digest64(right));
    // The legacy text keeps the old collision on purpose: it must match `hashtext` of today's code.
    expect(legacyPgText(left)).toBe(legacyPgText(right));
  });

  it('counts the length in UTF-8 bytes', () => {
    expect(createKey('ns', '🔒').full).toBe('1:2:ns:4:🔒');
  });

  it('keeps case apart', () => {
    expect(createKey('ns', 'Job').full).not.toBe(createKey('ns', 'job').full);
  });

  it('splits the digest into signed 32-bit ints', () => {
    const { hi, lo } = toPgPair(createKey('a', 'b'));
    for (const value of [hi, lo]) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(-(2 ** 31));
      expect(value).toBeLessThan(2 ** 31);
    }
  });

  it.each([
    ['empty name', 'ns', ''],
    ['empty namespace', '', 'name'],
    ['513-byte name', 'ns', 'y'.repeat(513)],
    ['513-byte namespace', 'y'.repeat(513), 'name'],
    ['257 two-byte characters', 'ns', 'é'.repeat(257)],
    ['lone surrogate', 'ns', '\uD800'],
  ])('rejects %s with a config error', (_label, ns, name) => {
    expect(() => createKey(ns, name)).toThrow(LockError);
    try {
      createKey(ns, name);
    } catch (error) {
      expect(error).toMatchObject({ code: 'config', errorCode: 'ARKI_LOCK_E006' });
    }
  });

  it('accepts exactly 512 bytes', () => {
    expect(() => createKey('ns', 'é'.repeat(256))).not.toThrow();
  });
});

/** A seeded generator, so a failure reproduces. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6D_2B_79_F5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Random text mixing ASCII, BMP, astral characters and lone (or reversed) surrogates. */
function randomText(random: () => number, maxUnits: number): string {
  const pick = (low: number, high: number): number => low + Math.floor(random() * (high - low + 1));
  let text = '';
  const units = pick(0, maxUnits);
  while (text.length < units) {
    const kind = random();
    if (kind < 0.35) text += String.fromCodePoint(pick(0, 0x7F));
    else if (kind < 0.6) text += String.fromCodePoint(pick(0x80, 0xD7_FF));
    else if (kind < 0.7) text += String.fromCodePoint(pick(0xE0_00, 0xFF_FF));
    else if (kind < 0.88) text += String.fromCodePoint(pick(0x1_00_00, 0x10_FF_FF));
    else if (kind < 0.95) text += String.fromCodePoint(pick(0xD8_00, 0xDF_FF));
    else text += String.fromCodePoint(pick(0xDC_00, 0xDF_FF), pick(0xD8_00, 0xDB_FF));
  }
  return text;
}

describe('inline UTF-8', () => {
  it('hashes every string byte for byte like FNV over TextEncoder, so no Postgres key moves', () => {
    const random = seeded(1);
    for (let round = 0; round < 3000; round++) {
      const text = randomText(random, 40);
      expect(fnv1a64Utf8(text), JSON.stringify(text)).toBe(fnv1a64(bytes(text)));
      if (keyNameSchema.safeParse(text).success) {
        const key = createKey('n', text);
        expect(digest64(key)).toBe(fnv1a64(bytes(key.full)));
      }
    }
  });

  it('accepts and refuses exactly what keyNameSchema does and counts the same bytes, so keys never change', () => {
    const random = seeded(2);
    for (let round = 0; round < 3000; round++) {
      const text = randomText(random, round % 10 === 0 ? 300 : 30);
      const accepted = keyNameSchema.safeParse(text).success;
      let full: string | undefined;
      try {
        full = createKey('ns', text).full;
      } catch (error) {
        expect(error).toMatchObject({ code: 'config' });
      }
      expect(full !== undefined, JSON.stringify(text)).toBe(accepted);
      if (full !== undefined) expect(full).toBe(`1:2:ns:${bytes(text).length}:${text}`);
    }
  });

  it('words a refusal exactly as the schema does', () => {
    expect(() => createKey('ns', '')).toThrow('lock name must not be empty');
    expect(() => createKey('ns', '\uD800')).toThrow('lock name must not contain lone surrogates');
    expect(() => createKey('y'.repeat(513), 'n')).toThrow('lock namespace must be at most 512 bytes');
  });
});
