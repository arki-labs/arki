import { describe, expect, it } from 'vitest';

import { LockError } from './errors.js';
import { createKey, digest64, fnv1a64, legacyPgText, toPgPair } from './key.js';

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
  { ns: 'a', name: 'b', full: '1:1:a:1:b', digest: 0x27_E5_FB_35_A8_20_2E_BDn, hi: 669_383_477, lo: -1_474_285_891 },
  {
    ns: 'a:b',
    name: 'c',
    full: '1:3:a:b:1:c',
    digest: 0x74_00_48_A6_95_6B_CE_D8n,
    hi: 1_946_175_654,
    lo: -1_788_096_808,
  },
  {
    ns: 'a',
    name: 'b:c',
    full: '1:1:a:3:b:c',
    digest: 0x97_E2_6A_E3_CF_85_E3_4Cn,
    hi: -1_746_769_181,
    lo: -813_309_108,
  },
  {
    ns: 'avocabo',
    name: 'send-digest',
    full: '1:7:avocabo:11:send-digest',
    digest: 0x2F_5B_C3_07_F1_7B_9F_09n,
    hi: 794_542_855,
    lo: -243_556_599,
  },
  {
    ns: 'kapodopera',
    name: 'tracking:usr_1:cnt_2',
    full: '1:10:kapodopera:20:tracking:usr_1:cnt_2',
    digest: 0x65_97_87_CE_2C_15_FB_F2n,
    hi: 1_704_429_518,
    lo: 739_638_258,
  },
  {
    ns: 'ns',
    name: 'héllo wörld',
    full: '1:2:ns:13:héllo wörld',
    digest: 0xEA_AC_57_EF_15_1C_C8_2En,
    hi: -357_804_049,
    lo: 354_207_790,
  },
  {
    ns: 'ns',
    name: '日本語🔒',
    full: '1:2:ns:13:日本語🔒',
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
