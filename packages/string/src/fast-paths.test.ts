/**
 * The fast paths must never change a result. ASCII case splitting and the "simple text" grapheme
 * scan (code units below U+0300 need no segmenter) are each checked against the general path on
 * random mixes of the characters where the two could disagree.
 */

import { describe, expect, it } from 'vitest';

import { caseWords } from './case.js';
import { truncate } from './format.js';
import { boundaryAt, boundaryIfLonger, graphemeBoundaries, graphemeCount } from './internal/graphemes.js';

/** Deterministic pseudo-random numbers in [0, 1). */
function rng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

function randomText(next: () => number, pool: readonly string[], maxPieces: number): string {
  let text = '';
  const pieces = Math.floor(next() * (maxPieces + 1));
  for (let i = 0; i < pieces; i++) text += pool[Math.floor(next() * pool.length)] ?? '';
  return text;
}

// A trailing no-break space is a boundary that changes no token, but it sends the text through
// the general Unicode tokenizer, so the two paths can be compared directly.
const NO_BREAK_SPACE = String.fromCodePoint(0xa0);
function viaUnicodePath(text: string): string[] {
  return caseWords(text + NO_BREAK_SPACE);
}

describe('ASCII case splitting', () => {
  it('gives the same tokens as the Unicode tokenizer', () => {
    const pool = ['a', 'b', 'Z', 'Q', 'x', '0', '7', '_', '-', ' ', '.', "'", '&'];
    const next = rng(7);
    for (let round = 0; round < 3000; round++) {
      const text = randomText(next, pool, 12);
      expect(caseWords(text), JSON.stringify(text)).toEqual(viaUnicodePath(text));
    }
  });

  it('keeps the documented edge cases', () => {
    for (const text of [
      'XMLHttpRequest',
      'HTTPServer2Go',
      'v2Beta',
      "don't stop",
      "it'S",
      "a''b",
      "'quoted'",
      'ABc',
      'aBC',
      '',
    ]) {
      expect(caseWords(text), text).toEqual(viaUnicodePath(text));
    }
  });
});

describe('simple-text grapheme scan', () => {
  const pool = [
    'a',
    'Z',
    ' ',
    '\r',
    '\n',
    'é', // precomposed
    '©', // © is Extended_Pictographic
    '­', // soft hyphen, a control
    '́', // combining acute
    '️',
    '‍',
    '\u{1F44D}',
    '\u{1F3FD}',
    '\u{1F1F7}',
    '\u{1F1F4}',
    '각', // Hangul syllable
    'ᄀ',
    'क', // Devanagari consonant
    '्', // virama
    '؀', // Prepend
    '…', // …
  ];

  it('agrees with full segmentation for counts and offsets', () => {
    const next = rng(11);
    for (let round = 0; round < 2000; round++) {
      const text = randomText(next, pool, 10);
      const full = graphemeBoundaries(text);
      const count = full.length - 1;
      const label = JSON.stringify(text);
      expect(graphemeCount(text), label).toBe(count);
      for (let position = 0; position <= count + 1; position++) {
        expect(boundaryAt(text, position), label).toBe(full[position]);
      }
      for (let limit = 0; limit <= count; limit++) {
        for (let position = 0; position <= limit; position++) {
          expect(boundaryIfLonger(text, position, limit), label).toBe(count > limit ? full[position] : undefined);
        }
      }
    }
  });

  it('truncates exactly as a cut at full grapheme boundaries would', () => {
    const next = rng(13);
    for (let round = 0; round < 2000; round++) {
      const text = randomText(next, pool, 12);
      const max = 1 + Math.floor(next() * 6);
      const full = graphemeBoundaries(text);
      const expected = full.length - 1 <= max ? text : `${text.slice(0, full[max - 1]).trimEnd()}…`;
      expect(truncate(text, max), JSON.stringify(text)).toBe(expected);
    }
  });
});
