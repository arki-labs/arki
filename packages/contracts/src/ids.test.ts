import { describe, expect, it } from 'vitest';

import { userIdSchema } from './ids.js';

describe('userIdSchema', () => {
  it('accepts a string that starts with usr_ and keeps it as is', () => {
    expect(userIdSchema.parse('usr_abc123')).toBe('usr_abc123');
  });

  it('rejects other prefixes and non-strings, so a session or account id cannot stand in for a user', () => {
    expect(userIdSchema.safeParse('sess_abc123').success).toBe(false);
    expect(userIdSchema.safeParse('abc123').success).toBe(false);
    expect(userIdSchema.safeParse(42).success).toBe(false);
    expect(userIdSchema.safeParse(null).success).toBe(false);
  });
});
