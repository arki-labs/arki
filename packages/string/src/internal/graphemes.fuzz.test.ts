/**
 * Property test: the in-house UAX #29 scanner must produce the same boundaries as the engine's
 * `Intl.Segmenter` on random mixes of the hard cases (emoji sequences, marks, Hangul jamo, Indic
 * conjuncts, tags, CR LF). The one known divergence is the Unicode 18 conjunct rule (GB9c), which
 * joins a linker to the next consonant even without a preceding consonant; ICU through Unicode 17
 * splits there. Strings that hit that case are excluded from the comparison.
 */

import { describe, expect, it } from 'vitest';

import { fallbackBoundaries } from './graphemes.js';

const POOL: readonly string[] = [
  'a',
  'Z',
  '1',
  ' ',
  '-',
  '\u00E9', // ASCII and precomposed
  '\u0301',
  '\u0308',
  '\u200D',
  '\u200C',
  '\uFE0F',
  '\u20E3', // marks, ZWJ, ZWNJ, VS16, keycap
  '\u{1F469}',
  '\u{1F4BB}',
  '\u{1F3FD}',
  '\u{1F6D1}',
  '\u{1F3F4}',
  '\u2764', // pictographs, modifier
  '\u{1F1F7}',
  '\u{1F1F4}',
  '\u{1F1EC}', // regional indicators
  '\u{E0067}',
  '\u{E0062}',
  '\u{E007F}', // tags
  '\u1100',
  '\u1161',
  '\u11A8',
  '\uAC00',
  '\uAC01', // Hangul L V T LV LVT
  '\u0915',
  '\u094D',
  '\u0924',
  '\u093E',
  '\u0995',
  '\u09CD', // Devanagari/Bengali consonants, virama, vowel sign
  '\u0600',
  '\u06DD', // prepend
  '\r',
  '\n',
  '\t',
  '\u2028',
];

/** Deterministic PRNG (mulberry32) so failures reproduce. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    // eslint-disable-next-line unicorn/prefer-math-trunc -- int32 wrap-around is the point
    state = (state + 0x6d_2b_79_f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

// Sets of code points, not character classes: combining marks inside `[...]` trip
// `no-misleading-character-class`, and we test one code point at a time anyway.
const LINKER = new Set([0x09_4d, 0x09_cd]);
const CONSONANT = new Set([0x09_15, 0x09_24, 0x09_95]);
const INCB_EXTEND = new Set([0x03_01, 0x03_08, 0x20_0d, 0x09_3e]);

/** True when a linker is followed by a consonant without a consonant earlier in the same run. */
function hitsUnicode18ConjunctRule(text: string): boolean {
  let consonantSeen = false;
  let linkerSeen = false;
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0;
    if (CONSONANT.has(cp)) {
      if (linkerSeen && !consonantSeen) return true;
      consonantSeen = true;
      linkerSeen = false;
    } else if (LINKER.has(cp)) {
      linkerSeen = true;
    } else if (!INCB_EXTEND.has(cp)) {
      consonantSeen = false;
      linkerSeen = false;
    }
  }
  return false;
}

describe('fallback scanner vs Intl.Segmenter (fuzz)', () => {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const native = (text: string): number[] => [...[...segmenter.segment(text)].map(s => s.index), text.length];

  it('agrees on 3000 random strings (seed 20261009)', () => {
    const next = random(20_261_009);
    const mismatches: string[] = [];
    let compared = 0;
    for (let round = 0; round < 3000; round += 1) {
      const size = 1 + Math.floor(next() * 8);
      let text = '';
      for (let i = 0; i < size; i += 1) text += POOL[Math.floor(next() * POOL.length)] ?? '';
      if (hitsUnicode18ConjunctRule(text)) continue;
      compared += 1;
      const expected = native(text);
      const actual = fallbackBoundaries(text);
      if (expected.join(',') !== actual.join(',')) {
        const escaped = [...text].map(c => `U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase()}`).join(' ');
        mismatches.push(`${escaped}: native ${expected.join(',')} fallback ${actual.join(',')}`);
      }
    }
    expect(compared).toBeGreaterThan(2500);
    expect(mismatches).toEqual([]);
  });
});
