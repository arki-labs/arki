/**
 * One backend, several brands (kapodopera serves ReadingPath, Strophie, ScreenCity...): each auth
 * mail names the brand of the site that asked for it, in the text and the sender. A mail sent with
 * no request keeps the default brand, never a guess.
 */
import { describe, expect, it } from 'vitest';

import { mailer } from '@arki/mail';
import { magicLink, resetPassword, verifyEmail } from '@arki/mail/templates/auth';
import { mailSink } from '@arki/mail/testing';

import type { AuthMailBrandPicker } from './types.js';
import { PASSWORD, post } from '../__fixtures__/http.js';
import { authTables } from '../__fixtures__/tables.js';
import { defineAuth } from '../definition.js';
import { testAuth } from '../testing/index.js';
import { authMail } from './mail.js';

const definition = defineAuth({
  app: { name: 'Kapodopera', key: 'kapodopera' },
  methods: ['password', 'magicLink'],
  verifyEmail: 'send',
});

const BRANDS: Readonly<Record<string, string>> = { 'readingpath.test': 'ReadingPath', 'strophie.test': 'Strophie' };

/** The brand of the site the request came through, read from the ingress host header. */
const brandOfHost: AuthMailBrandPicker = ({ request }) => {
  const appName = BRANDS[request?.headers.get('x-forwarded-host') ?? ''];
  return appName === undefined ? {} : { appName, from: `${appName} <auth@kapodopera.test>` };
};

const fromHost = (host: string) => ({ 'x-forwarded-host': host });

describe('mailBrand', () => {
  it('gives two hosts two brands for the magic link, verify and reset mails', async () => {
    const { auth, mail, dispose } = await testAuth(definition, { tables: authTables, mailBrand: brandOfHost });
    try {
      for (const [host, brand] of Object.entries(BRANDS)) {
        const email = `ada@${host}`;
        await post(auth, '/sign-in/magic-link', { email }, fromHost(host));
        await post(auth, '/sign-up/email', { email: `new.${email}`, password: PASSWORD, name: 'Ada' }, fromHost(host));
        await post(auth, '/request-password-reset', { email: `new.${email}`, redirectTo: '/reset' }, fromHost(host));

        const sent = [...mail.sentTo(email), ...mail.sentTo(`new.${email}`)];
        expect(new Set(sent.map(record => record.template))).toEqual(
          new Set([magicLink.name, resetPassword.name, verifyEmail.name]),
        );
        expect(sent).toHaveLength(3);
        for (const { message } of sent) {
          expect(message.from).toBe(`${brand} <auth@kapodopera.test>`);
          expect(message.text).toContain(brand);
          expect(message.text).not.toContain('Kapodopera');
        }
      }
    } finally {
      await dispose();
    }
  });

  it('keeps the default brand when the request has no known host', async () => {
    const { auth, mail, dispose } = await testAuth(definition, { tables: authTables, mailBrand: brandOfHost });
    try {
      await post(auth, '/sign-in/magic-link', { email: 'ada@notes.test' });
      const [record] = mail.sentTo('ada@notes.test');
      expect(record?.message.from).toBe('Kapodopera <auth@test.dev>');
      expect(record?.message.text).toContain('Kapodopera');
    } finally {
      await dispose();
    }
  });

  it('gets no request when the engine sends without one, and the default brand applies', async () => {
    const sink = mailSink();
    const requests: (Request | undefined)[] = [];
    const send = authMail({
      mail: mailer({ transport: sink, from: 'Kapodopera <auth@kapodopera.test>' }),
      templates: undefined,
      appName: 'Kapodopera',
      brand: ({ request }) => {
        requests.push(request);
        return {};
      },
    });
    await send.send('magicLink', 'ada@notes.test', 'https://kapodopera.test/link');
    expect(requests).toEqual([undefined]);
    expect(sink.sentTo('ada@notes.test')[0]?.message.from).toBe('Kapodopera <auth@kapodopera.test>');
    expect(sink.sentTo('ada@notes.test')[0]?.message.text).toContain('Kapodopera');
  });

  it('a picker that throws fails the mail with E006, never a send under the wrong brand', async () => {
    const { auth, mail, dispose } = await testAuth(definition, {
      tables: authTables,
      mailBrand: () => {
        throw new Error('brand table is down');
      },
    });
    try {
      const response = await post(auth, '/sign-in/magic-link', { email: 'ada@notes.test' });
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ code: 'ARKI_AUTH_E006' });
      expect(mail.sentTo('ada@notes.test')).toEqual([]);
    } finally {
      await dispose();
    }
  });
});
