// The auth mails are what sign-in (T10) sends. They must never go out blank, and the app name or
// link must never become live HTML or a `javascript:` link in someone's inbox.
import { describe, expect, it } from 'vitest';

import { MAIL_ERROR_CODES } from '../errors.js';
import { renderTemplate } from '../template.js';
import { magicLink, resetPassword, signInCode, verifyEmail } from './auth.js';

const url = 'https://app.example.com/auth/verify?token=abc&next=%2F';

describe('auth templates render subject, text and html', () => {
  const linkTemplates = [
    { template: magicLink, subject: 'Sign in to Notes', expiry: '15 minutes' },
    { template: verifyEmail, subject: 'Verify your email for Notes', expiry: '24 hours' },
    { template: resetPassword, subject: 'Reset your Notes password', expiry: '1 hour' },
  ];
  for (const { template, subject, expiry } of linkTemplates) {
    it(`${template.name}: link in text and html, default expiry applied`, async () => {
      const { data, error } = await renderTemplate(template, { appName: 'Notes', url });
      expect(error).toBeNull();
      expect(data?.subject).toBe(subject);
      expect(data?.text).toContain(url);
      expect(data?.text).toContain(`expires in ${expiry}`);
      expect(data?.html).toContain(`href="${url.replace('&', '&amp;')}"`);
      expect(data?.html).toContain(`expires in ${expiry}`);
    });
  }

  it('an explicit expiresInMinutes replaces the default', async () => {
    const { data } = await renderTemplate(magicLink, { appName: 'Notes', url, expiresInMinutes: 5 });
    expect(data?.text).toContain('expires in 5 minutes');
  });

  it('auth.sign-in-code: the code in text and html', async () => {
    const { data } = await renderTemplate(signInCode, { appName: 'Notes', code: '482913' });
    expect(data?.subject).toBe('Your Notes sign-in code');
    expect(data?.text).toContain('482913');
    expect(data?.html).toContain('482913');
  });
});

describe('auth templates are safe with hostile input', () => {
  it('escapes HTML in the app name', async () => {
    const { data } = await renderTemplate(magicLink, { appName: '<script>alert(1)</script>', url });
    expect(data?.html).not.toContain('<script>');
    expect(data?.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes HTML in a sign-in code', async () => {
    const { data } = await renderTemplate(signInCode, { appName: 'Notes', code: '"><img src=x>' });
    expect(data?.html).not.toContain('<img');
  });

  for (const bad of ['javascript:alert(1)', 'data:text/html,hi', '/relative/path', 'not a url']) {
    it(`refuses url "${bad}" with E003 and an issue on url`, async () => {
      const { data, error } = await renderTemplate(resetPassword, { appName: 'Notes', url: bad });
      expect(data).toBeNull();
      expect(error?.code).toBe(MAIL_ERROR_CODES.invalidInput);
      expect(error?.issues?.map(issue => issue.path)).toEqual([['url']]);
    });
  }

  it('refuses an app name with a line break, which would break the subject', async () => {
    const { error } = await renderTemplate(verifyEmail, { appName: 'Notes\nBcc: x@evil.test', url });
    expect(error?.code).toBe(MAIL_ERROR_CODES.invalidInput);
  });

  it('refuses a non-positive expiry', async () => {
    const { error } = await renderTemplate(magicLink, { appName: 'Notes', url, expiresInMinutes: 0 });
    expect(error?.issues?.map(issue => issue.path)).toEqual([['expiresInMinutes']]);
  });
});
