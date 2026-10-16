// Apps assert on mail through the sink instead of mocking modules. If the sink recorded the wrong
// template, matched the wrong recipient, or failed more than once, app tests would pass or fail
// for reasons that have nothing to do with the app.
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { SentRecord } from './testing.js';
import { MAIL_ERROR_CODES } from './errors.js';
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
    const { data } = await mail.send(
      magicLink,
      { appName: 'Notes', url },
      { to: 'ada@example.com', idempotencyKey: 'k1' },
    );
    expect(data?.status).toBe('simulated');
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
    await mail.send(magicLink, { appName: 'Notes', url }, { to: 'ada@example.com' });
    await mail.send(signInCode, { appName: 'Notes', code: '123456' }, { to: 'ada@example.com' });
    const links = sink.sentWith(magicLink);
    expect(links.map(record => record.template)).toEqual(['auth.magic-link']);
    expectTypeOf(links).toEqualTypeOf<readonly SentRecord<'auth.magic-link'>[]>();
  });

  it('sentTo matches the mailbox in To, Cc or Bcc, ignoring display name and case', async () => {
    const { sink, mail } = setup();
    await mail.sendRaw({ to: 'Ada <Ada@Example.com>', subject: 'a', text: 'a' });
    await mail.sendRaw({ to: 'bob@example.com', bcc: 'ada@example.com', subject: 'b', text: 'b' });
    await mail.sendRaw({ to: 'bob@example.com', subject: 'c', text: 'c' });
    expect(sink.sentTo('ada@example.com').map(record => record.message.subject)).toEqual(['a', 'b']);
  });

  it('failNext fails exactly the next send, which is not recorded', async () => {
    const { sink, mail } = setup();
    sink.failNext({ code: MAIL_ERROR_CODES.uncertain, retryable: true, acceptance: 'unknown' });
    const first = await mail.sendRaw({ to: 'ada@example.com', subject: 'a', text: 'a' });
    const second = await mail.sendRaw({ to: 'ada@example.com', subject: 'b', text: 'b' });
    expect(first.error).toMatchObject({ code: MAIL_ERROR_CODES.uncertain, retryable: true, transport: 'sink' });
    expect(second.error).toBeNull();
    expect(sink.sent.map(record => record.message.subject)).toEqual(['b']);
  });

  it('clear forgets mails and a pending failure', async () => {
    const { sink, mail } = setup();
    await mail.sendRaw({ to: 'ada@example.com', subject: 'a', text: 'a' });
    sink.failNext();
    sink.clear();
    const { error } = await mail.sendRaw({ to: 'ada@example.com', subject: 'b', text: 'b' });
    expect(error).toBeNull();
    expect(sink.sent).toHaveLength(1);
  });
});
