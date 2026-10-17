import { describe, expect, it } from 'vitest';

import { redactSecrets } from './redact.ts';

describe('redactSecrets', () => {
  it('removes credentials and caps length, so an error shown in Foreman never leaks a secret', () => {
    expect(redactSecrets('auth failed: Bearer abcdefghijklmnop')).toBe('auth failed: Bearer [REDACTED]');
    expect(redactSecrets('{"api_key":"sk-live-abcdef123456"}')).not.toContain('abcdef123456');
    expect(redactSecrets('x'.repeat(2000)).length).toBeLessThan(510);
  });

  it('redacts a secret near the start of a huge message, because only the first part is scanned', () => {
    const out = redactSecrets(`password=hunter2 ${'x'.repeat(1_000_000)}`);
    expect(out).not.toContain('hunter2');
    expect(out.length).toBeLessThan(510);
  });
});
