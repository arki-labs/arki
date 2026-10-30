/**
 * Message checks run before any transport sees the mail. Why: a line break in a header lets
 * user input add headers of its own (header injection), and a staging server must never mail
 * a real customer.
 */
import { describe, expect, it } from 'vitest';

import type { MailMessage } from './types.js';
import { MailInvalidMessage } from './failures.js';
import { checkMessage, redirect } from './message.js';

const base: MailMessage = { from: 'App <hi@app.dev>', to: 'ada@example.com', subject: 'Hi', text: 'Hello' };

describe('checkMessage', () => {
  it('accepts a complete message', () => {
    expect(checkMessage(base)).toBeUndefined();
  });

  it.each([
    ['no recipient', { ...base, to: [] }],
    ['a line break in the subject', { ...base, subject: 'Hi\r\nBcc: victim@example.com' }],
    ['a line break in an address', { ...base, to: 'ada@example.com\nBcc: victim@example.com' }],
    ['a line break in a header value', { ...base, headers: { 'X-Ref': 'a\r\nBcc: victim@example.com' } }],
    ['a reserved header', { ...base, headers: { Bcc: 'victim@example.com' } }],
    ['an empty address', { ...base, cc: [''] }],
    // Recipients are usually typed by a user, so a bad one is an outcome to show, never a crash.
  ])('refuses %s with a returned MailInvalidMessage, and never throws', (_case, message) => {
    const refused = checkMessage(message);
    expect(MailInvalidMessage.is(refused)).toBe(true);
    expect(refused).toMatchObject({ code: 'mail.invalid_message', status: 422 });
  });

  it('accepts a message with only a Bcc recipient', () => {
    expect(checkMessage({ ...base, to: [], bcc: 'ops@app.dev' })).toBeUndefined();
  });
});

describe('redirect', () => {
  it('sends to the staging inbox only, and keeps the original To for debugging', () => {
    const redirected = redirect(
      { ...base, to: ['ada@example.com', 'bob@example.com'], cc: 'boss@example.com', bcc: 'audit@example.com' },
      'staging@app.dev',
    );
    expect(redirected.to).toBe('staging@app.dev');
    expect(redirected.cc).toBeUndefined();
    expect(redirected.bcc).toBeUndefined();
    expect(redirected.headers).toEqual({ 'X-Original-To': 'ada@example.com, bob@example.com' });
  });
});
