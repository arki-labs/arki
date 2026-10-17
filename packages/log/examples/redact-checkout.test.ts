import { beforeEach, describe, expect, it } from 'vitest';

import { signIn, sink } from './redact-checkout.js';

describe('signIn', () => {
  beforeEach(() => {
    sink.clear();
  });

  it('keeps the user id as a field and censors the password before any sink sees it', () => {
    signIn('usr_1', 'hunter2');
    const [record] = sink.records;
    expect(record?.message()).toBe('user usr_1 signed in');
    expect(record?.fields).toEqual({ userId: 'usr_1', password: '[REDACTED]' });
  });
});
