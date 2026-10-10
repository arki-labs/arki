/**
 * Guards against complexity regressions on the paths that were quadratic or allocation-heavy
 * before 0.1.1. Each check compares the time for a large input against a small one and asserts
 * the ratio, so it is insensitive to machine speed: a linear path scales ~10× for 10× input, a
 * quadratic one ~100×. Thresholds are deliberately loose to survive CI noise.
 */

import { describe, expect, it } from 'vitest';

import { excerpt } from './format.js';
import { sentences } from './segment.js';
import { slugify } from './slug.js';
import { chinese } from './slug/rules-cjk.js';
import { at, take } from './unicode.js';

function millis(fn: () => unknown, runs = 3): number {
  fn(); // warm up
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < runs; i += 1) {
    const started = performance.now();
    fn();
    best = Math.min(best, performance.now() - started);
  }
  return Math.max(best, 0.01);
}

const SMALL = 'The quick brown fox 👩‍💻 jumps over the lazy dog é. '.repeat(200); // ~10k chars
const LARGE = SMALL.repeat(10); // ~100k chars

/** Repeated so each sample is well above timer resolution; a linear path would still scale ~10×. */
const lookups = (text: string) => (): void => {
  for (let i = 0; i < 300; i += 1) {
    at(text, 5);
    take(text, 20);
  }
};

describe('complexity guards', () => {
  it('sentences() scales linearly with punctuation runs', () => {
    const small = millis(() => sentences('!'.repeat(4000) + 'x'));
    const large = millis(() => sentences('!'.repeat(40_000) + 'x'));
    expect(large / small).toBeLessThan(40);
  });

  it('positional lookups near the start do not scale with text length', () => {
    const small = millis(lookups(SMALL));
    const large = millis(lookups(LARGE));
    expect(large / small).toBeLessThan(5);
  });

  it('a literal miss in excerpt() does not pay for segmentation', () => {
    const miss = millis(() => excerpt(LARGE, 'zzz'));
    const hit = millis(() => excerpt(LARGE, 'lazy'));
    expect(hit / miss).toBeGreaterThan(5);
  });

  it('user slug tables compile once per array instance', () => {
    const shared = [...chinese];
    const fresh = millis(() => slugify('我是谁 hello', { replacements: [...chinese] }), 2); // new array: compiles
    const cached = millis(() => slugify('我是谁 hello', { replacements: shared }), 3); // same array: cache hit
    expect(fresh / cached).toBeGreaterThan(3);
  });
});
