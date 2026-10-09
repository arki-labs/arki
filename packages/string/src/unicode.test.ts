import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { fallbackBoundaries } from './internal/graphemes.js';
import { at, chunk, graphemes, length, reverse, slice, splice, take } from './unicode.js';

const FAMILY = '👨‍👩‍👧‍👦';
const FLAG = '🇷🇴';
const THUMBS = '👍🏽';
const E_ACUTE_NFD = 'é';
const KSHA = 'क्ष';

describe('graphemes / length', () => {
  it.each([
    ['', 0, 0],
    [E_ACUTE_NFD, 2, 1],
    [FAMILY, 11, 1],
    [FLAG, 4, 1],
    [THUMBS, 4, 1],
    ['\r\n', 2, 1],
    [KSHA, 3, 1],
    ['́a', 2, 2],
    ['한글', 2, 2],
    ['각', 3, 1],
  ])('%j has %i code units and %i graphemes', (text, units, count) => {
    expect(text.length).toBe(units);
    expect(length(text)).toBe(count);
    expect([...graphemes(text)].join('')).toBe(text);
  });
});

describe('positional operations', () => {
  const sample = `A👩‍💻B`;
  it('at', () => {
    expect(at(sample, 1)).toBe('👩‍💻');
    expect(at(sample, -1)).toBe('B');
    expect(at(sample, 3)).toBeUndefined();
    expect(at(sample, -4)).toBeUndefined();
    expect(() => at(sample, 1.5)).toThrow(RangeError);
  });
  it('slice', () => {
    expect(slice(sample, 1, 2)).toBe('👩‍💻');
    expect(slice(sample, -2)).toBe('👩‍💻B');
    expect(slice(sample, 2, 1)).toBe('');
    expect(slice(sample, 0, 99)).toBe(sample);
  });
  it('take', () => {
    expect(take(sample, -2)).toBe('👩‍💻B');
    expect(take(sample, 1)).toBe('A');
    expect(take(sample, 0)).toBe('');
    expect(take(sample, 10)).toBe(sample);
  });
  it('reverse keeps graphemes intact', () => {
    expect(reverse(sample)).toBe('B👩‍💻A');
    expect(reverse(`${FLAG}${E_ACUTE_NFD}`)).toBe(`${E_ACUTE_NFD}${FLAG}`);
  });
  it('splice', () => {
    expect(splice(sample, 1, 1, '-')).toBe('A-B');
    expect(splice(sample, 1, 0, 'x')).toBe('Ax👩‍💻B');
    expect(splice(sample, -1, 5)).toBe('A👩‍💻');
    expect(() => splice(sample, 0, -1)).toThrow(RangeError);
  });
  it('chunk', () => {
    expect(chunk(`ab${FAMILY}cd`, 2)).toEqual(['ab', `${FAMILY}c`, 'd']);
    expect(chunk('', 3)).toEqual([]);
    expect(chunk('abc', 3).join('')).toBe('abc');
    expect(() => chunk('abc', 0)).toThrow(RangeError);
  });
});

describe('UAX #29 fallback scanner', () => {
  const unassigned = /\p{Cn}/u;
  const corpus = readFileSync(new URL('__tests__/fixtures/GraphemeBreakTest.txt', import.meta.url), 'utf8');

  type Case = { text: string; expected: number[]; line: string };
  const cases: Case[] = [];
  let skipped = 0;
  for (const raw of corpus.split('\n')) {
    const line = raw.split('#')[0]?.trim() ?? '';
    if (line === '') continue;
    const tokens = line.split(/\s+/);
    let text = '';
    const expected: number[] = [];
    for (const token of tokens) {
      if (token === '÷') expected.push(text.length);
      else if (token !== '×') text += String.fromCodePoint(Number.parseInt(token, 16));
    }
    if (unassigned.test(text)) {
      skipped += 1; // the engine's Unicode tables predate this code point
      continue;
    }
    cases.push({ text, expected, line });
  }

  it('parses the corpus', () => {
    expect(cases.length).toBeGreaterThan(500);
  });

  it('passes every applicable conformance line', () => {
    const failures = cases
      .filter(({ text, expected }) => fallbackBoundaries(text).join(',') !== expected.join(','))
      .map(
        ({ line, text, expected }) => `${line} → got ${fallbackBoundaries(text).join(',')} want ${expected.join(',')}`,
      );
    expect(failures, `${failures.length} failing lines (${skipped} skipped as unassigned)`).toEqual([]);
  });

  it('agrees with Intl.Segmenter on the fixture table', () => {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    for (const text of ['', E_ACUTE_NFD, FAMILY, FLAG, THUMBS, '\r\n', KSHA, '́a', '한글', 'a🇷🇴🇷🇴b', '👩🏽‍🚀x']) {
      const native = [...segmenter.segment(text)].map(segment => segment.index);
      native.push(text.length);
      expect(fallbackBoundaries(text), JSON.stringify(text)).toEqual(native);
    }
  });
});
