import { describe, expect, it } from 'vitest';

import { calculateReadingTime } from './post.js';

describe('calculateReadingTime', () => {
  it('leaves inline svg out of the count', () => {
    const words = 'word '.repeat(400);
    const svg = `<svg viewBox="0 0 1 1">${'<path d="M0 0" /> '.repeat(2000)}</svg>`;
    expect(calculateReadingTime(`${words}${svg}${svg}`)).toBe(calculateReadingTime(words));
  });

  // Why: a post is file contents, which is outside text. Many `<svg` with no `</svg>` after them made the strip
  // pattern read on to the end from each one; the count must take one pass.
  it('counts a large post of unclosed svg tags in one pass', () => {
    const flood = '<svg '.repeat(200_000);
    const started = performance.now();
    const time = calculateReadingTime(`intro <svg>x</svg> ${flood}`);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(time).toBe(calculateReadingTime(`intro  ${flood}`));
  });
});
