// Apps assert on mail through the sink instead of mocking modules. If the sink recorded the wrong
// template, matched the wrong recipient, or failed more than once, app tests would pass or fail
// for reasons that have nothing to do with the app.
import { describe, expect, expectTypeOf, it } from 'vitest';

import { isFailure, orThrow } from '@arki/failure';

import type { SentRecord } from './testing.js';
import { MailUncertain } from './failures.js';
import { mailer } from './mailer.js';
import { magicLink, signInCode } from './templates/auth.js';
import { mailSink } from './testing.js';

const url = 'https://app.example.com/login?t=1';

function setup() {
  const sink = mailSink();
  return { sink, mail: mailer({ transport: sink, from: 'App <hi@app.example.com>' }) };
}

describe('mailSink', () => {
  it('records the rendered message, the template name and the idempotency key', async () => {
    const { sink, mail } = setup();
    const sent = await mail.send(magicLink, { appName: 'Notes', url }, { to: 'ada@example.com', idempotencyKey: 'k1' });
    expect(sent).toMatchObject({ status: 'simulated' });
    expect(sink.sent).toHaveLength(1);
    expect(sink.last()).toMatchObject({
      template: 'auth.magic-link',
      idempotencyKey: 'k1',
      message: { to: 'ada@example.com', subject: 'Sign in to Notes', from: 'App <hi@app.example.com>' },
    });
    expect(sink.last()?.message.text).toContain(url);
  });

  it('sentWith returns only that template, typed by its name', async () => {
    const { sink, mail } = setup();
    await orThrow(mail.send(magicLink, { appName: 'Notes', url }, { to: 'ada@example.com' }));
    await orThrow(mail.send(signInCode, { appName: 'Notes', code: '123456' }, { to: 'ada@example.com' }));
    const links = sink.sentWith(magicLink);
    expect(links.map(record => record.template)).toEqual(['auth.magic-link']);
    expectTypeOf(links).toEqualTypeOf<readonly SentRecord<'auth.magic-link'>[]>();
  });

  it('sentTo matches the mailbox in To, Cc or Bcc, ignoring display name and case', async () => {
    const { sink, mail } = setup();
    await orThrow(mail.sendRaw({ to: 'Ada <Ada@Example.com>', subject: 'a', text: 'a' }));
    await orThrow(mail.sendRaw({ to: 'bob@example.com', bcc: 'ada@example.com', subject: 'b', text: 'b' }));
    await orThrow(mail.sendRaw({ to: 'bob@example.com', subject: 'c', text: 'c' }));
    expect(sink.sentTo('ada@example.com').map(record => record.message.subject)).toEqual(['a', 'b']);
  });

  it('failNext fails exactly the next send, which is not recorded', async () => {
    const { sink, mail } = setup();
    sink.failNext(MailUncertain({ transport: 'sink', detail: 'timed out' }));
    const first = await mail.sendRaw({ to: 'ada@example.com', subject: 'a', text: 'a' });
    const second = await mail.sendRaw({ to: 'ada@example.com', subject: 'b', text: 'b' });
    expect(MailUncertain.is(first)).toBe(true);
    expect(isFailure(second)).toBe(false);
    expect(sink.sent.map(record => record.message.subject)).toEqual(['b']);
  });

  it('clear forgets mails and a pending failure', async () => {
    const { sink, mail } = setup();
    await orThrow(mail.sendRaw({ to: 'ada@example.com', subject: 'a', text: 'a' }));
    sink.failNext();
    sink.clear();
    const sent = await mail.sendRaw({ to: 'ada@example.com', subject: 'b', text: 'b' });
    expect(isFailure(sent)).toBe(false);
    expect(sink.sent).toHaveLength(1);
  });
});
