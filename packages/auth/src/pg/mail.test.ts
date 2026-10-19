/**
 * A failed auth mail can never look like success: the answer is E006 with a generic message
 * (no transport details), and no sign-in is reported for a flow whose mail did not go out.
 */
import { describe, expect, it } from 'vitest';

import { ValidatorDefect } from '@arki/failure';
import { MailRejected } from '@arki/mail';

import { PASSWORD, post } from '../__fixtures__/http.js';
import { authTables } from '../__fixtures__/tables.js';
import { defineAuth } from '../definition.js';
import { AUTH_ERROR_CODES } from '../errors.js';
import { testAuth } from '../testing/index.js';
import { authMail } from './mail.js';

describe('auth mail failures', () => {
  it('throws validator defects at the auth callback instead of treating them as delivery refusals', async () => {
    const failure = ValidatorDefect({ cause: new Error('validator crashed') });
    const mail = authMail({
      mail: { send: () => Promise.resolve(failure) },
      templates: undefined,
      appName: 'Notes',
      brand: undefined,
    });

    await expect(mail.send('magicLink', 'ada@notes.test', 'https://notes.test/link')).rejects.toMatchObject({
      code: failure.code,
    });
  });

  it('a failed magic-link mail answers E006 with a generic message', async () => {
    const definition = defineAuth({ app: { name: 'Notes', key: 'notes' }, methods: ['magicLink'] });
    const { auth, mail, dispose } = await testAuth(definition, { tables: authTables });
    try {
      mail.failNext(
        MailRejected({ transport: 'sink', retryable: false, detail: 'resend: invalid api key re_live_123' }),
      );
      const response = await post(auth, '/sign-in/magic-link', { email: 'ada@notes.test' });
      expect(response.status).toBe(500);
      const body: unknown = await response.json();
      expect(body).toMatchObject({ code: AUTH_ERROR_CODES.mailFailed });
      expect(JSON.stringify(body)).not.toContain('re_live_123');
    } finally {
      await dispose();
    }
  });

  it('a failed verify mail reports no sign-in, and asking again answers E006', async () => {
    // The engine sends the sign-up's verify mail as a background task and only logs its failure,
    // so the sign-up itself answers 200. With `verifyEmail: 'require'` no session exists until the
    // link is used, so nothing can look signed in; an explicit resend surfaces the failure.
    const definition = defineAuth({ app: { name: 'Notes', key: 'notes' }, methods: ['password'] });
    const signIns: unknown[] = [];
    const { auth, mail, dispose } = await testAuth(definition, {
      tables: authTables,
      on: { signIn: event => void signIns.push(event) },
    });
    try {
      mail.failNext();
      const signUp = await post(auth, '/sign-up/email', { email: 'ada@notes.test', password: PASSWORD, name: 'Ada' });
      expect(
        signUp.headers.getSetCookie().filter(line => line.includes('session_token=') && !/max-age=0/i.test(line)),
      ).toEqual([]);
      expect(signIns).toHaveLength(0);
      expect(mail.sent).toHaveLength(0);

      mail.failNext();
      const resend = await post(auth, '/send-verification-email', { email: 'ada@notes.test' });
      expect(resend.status).toBe(500);
      expect(await resend.json()).toMatchObject({ code: AUTH_ERROR_CODES.mailFailed });
    } finally {
      await dispose();
    }
  });

  it('sends each mail with the app name and the link lifetime', async () => {
    const definition = defineAuth({ app: { name: 'Notes', key: 'notes' }, methods: ['magicLink'] });
    const { auth, mail, dispose } = await testAuth(definition, { tables: authTables });
    try {
      await post(auth, '/sign-in/magic-link', { email: 'ada@notes.test' });
      const [sent] = mail.sentTo('ada@notes.test');
      expect(sent?.template).toBe('auth.magic-link');
      expect(sent?.message.subject).toBe('Sign in to Notes');
      expect(sent?.message.text).toContain('5 minutes');
    } finally {
      await dispose();
    }
  });
});
