import { describe, expect, it } from 'vitest';

import { withoutTrailingSlashes } from './client-key.js';

// The engine path decides which endpoints are closed and which ones key the rate limit on the body
// email. A caller picks the path, so trimming it must stay linear on any slash run.
describe('withoutTrailingSlashes', () => {
  it.each([
    ['/sign-in/email/', '/sign-in/email'],
    ['/sign-in/email///', '/sign-in/email'],
    ['/sign-in/email', '/sign-in/email'],
    ['///', ''],
    ['', ''],
    ['/a//b/', '/a//b'],
  ])('trims %j to %j', (path, trimmed) => {
    expect(withoutTrailingSlashes(path)).toBe(trimmed);
  });

  it('trims a 1 MB path of slashes that does not end in one, in one pass', () => {
    const path = `${'/'.repeat(1_000_000)}x`;
    const started = Date.now();
    expect(withoutTrailingSlashes(path)).toBe(path);
    expect(withoutTrailingSlashes(`${path}///`)).toBe(path);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
