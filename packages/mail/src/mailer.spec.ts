/**
 * The mailer between the app and a transport. Why these tests matter: the sender address is a
 * deliverability setting, telemetry must never send a mail twice, and a local run must never
 * reach a real inbox.
 */
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { orThrow } from '@arki/failure';

import type { MailEvent, MailMessage, MailTransport } from './types.js';
import { MAIL_ERROR_CODES, MailError } from './errors.js';
import { MailInvalidInput, MailQuotaExhausted, MailUncertain } from './failures.js';
import { logTransport } from './log-transport.js';
import { mailer } from './mailer.js';
import { defineTemplate } from './template.js';

const receipt = defineTemplate({
  name: 'receipt',
  input: z.object({ total: z.string() }),
  subject: data => `Receipt: ${data.total}`,
  text: data => `You paid ${data.total}.`,
  defaults: { from: 'Billing <billing@app.dev>' },
});
const note = defineTemplate({
  name: 'note',
  input: z.object({ body: z.string() }),
  subject: () => 'Note',
  text: data => data.body,
});

/** Records what it is asked to send and accepts it. */
function recording(id = 'rec', quotaPerMonth?: number) {
  const sent: MailMessage[] = [];
  const send = vi.fn((message: MailMessage) => {
    sent.push(message);
    return Promise.resolve({ id: `m${sent.length}`, transport: id, status: 'accepted' as const, recipients: [] });
  });
  const transport: MailTransport = { id, quotaPerMonth, send };
  return { transport, sent, send };
}

describe('sender', () => {
  it('uses the call, then the template default, then the mailer default', async () => {
    const { transport, sent } = recording();
    const mail = mailer({ transport, from: 'App <hi@app.dev>' });
    await orThrow(mail.send(note, { body: 'x' }, { to: 'ada@example.com' }));
    await orThrow(mail.send(receipt, { total: '5 EUR' }, { to: 'ada@example.com' }));
    await orThrow(mail.send(receipt, { total: '5 EUR' }, { to: 'ada@example.com', from: 'Ops <ops@app.dev>' }));
    expect(sent.map(message => message.from)).toEqual([
      'App <hi@app.dev>',
      'Billing <billing@app.dev>',
      'Ops <ops@app.dev>',
    ]);
    expect(sent[1]).toMatchObject({ template: 'receipt', subject: 'Receipt: 5 EUR', text: 'You paid 5 EUR.' });
  });

  it('an empty mailer sender is a configuration error at startup, not at the first mail', () => {
    expect(() => mailer({ transport: logTransport(), from: ' ' })).toThrow(/from/);
  });
});

describe('an unsent mail is a returned failure; misuse throws', () => {
  it('bad input is returned as MailInvalidInput for the caller to branch on, and no transport is called', async () => {
    const { transport, send } = recording();
    const mail = mailer({ transport, from: 'hi@app.dev' });
    // @ts-expect-error -- total must be a string
    const result = await mail.send(receipt, { total: 5 }, { to: 'ada@example.com' });
    expect(MailInvalidInput.is(result)).toBe(true);
    expect(result).toMatchObject({ data: { template: 'receipt', issues: [{ path: ['total'] }] } });
    expect(send).not.toHaveBeenCalled();
  });

  it('a transport that throws is returned as uncertain: the request may have gone out', async () => {
    const transport: MailTransport = { id: 'flaky', send: () => Promise.reject(new Error('socket hang up')) };
    const result = await mailer({ transport, from: 'hi@app.dev' }).sendRaw({ to: 'a@b.c', subject: 's', text: 't' });
    expect(MailUncertain.is(result)).toBe(true);
    expect(result).toMatchObject({ data: { transport: 'flaky' } });
  });

  it('a message with no recipient is a bug in the calling code, so it throws E002 before any transport', async () => {
    const { transport, send } = recording();
    const mail = mailer({ transport, from: 'hi@app.dev' });
    await expect(mail.sendRaw({ to: [], subject: 's', text: 't' })).rejects.toMatchObject({
      code: MAIL_ERROR_CODES.invalidMessage,
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('a field the transport cannot carry is misuse: its MailError reaches the caller, not an uncertain send', async () => {
    const transport: MailTransport = {
      id: 'strict',
      send: () => Promise.reject(new MailError(MAIL_ERROR_CODES.unsupported, 'strict cannot carry tags')),
    };
    const mail = mailer({ transport, from: 'hi@app.dev' });
    await expect(mail.sendRaw({ to: 'a@b.c', subject: 's', text: 't' })).rejects.toThrow(MailError);
  });

  it('a failed send is reported to onEvent as the failure value', async () => {
    const events: MailEvent[] = [];
    const transport: MailTransport = { id: 'flaky', send: () => Promise.reject(new Error('socket hang up')) };
    const mail = mailer({ transport, from: 'hi@app.dev', onEvent: event => void events.push(event) });
    expect(MailUncertain.is(await mail.sendRaw({ to: 'a@b.c', subject: 's', text: 't' }))).toBe(true);
    const failed = events.find(event => event.type === 'failed');
    expect(failed?.type === 'failed' && MailUncertain.is(failed.failure)).toBe(true);
  });
});

describe('events', () => {
  it('reports sending then sent, with the template name', async () => {
    const events: MailEvent[] = [];
    const mail = mailer({
      transport: recording().transport,
      from: 'hi@app.dev',
      onEvent: event => void events.push(event),
    });
    await orThrow(mail.send(note, { body: 'x' }, { to: 'ada@example.com' }));
    expect(events.map(event => [event.type, event.template])).toEqual([
      ['sending', 'note'],
      ['sent', 'note'],
    ]);
  });

  it('an observer that throws after the provider accepted does not fail or repeat the send', async () => {
    const { transport, send } = recording();
    const mail = mailer({
      transport,
      from: 'hi@app.dev',
      onEvent: event => {
        if (event.type === 'sent') throw new Error('metrics down');
      },
    });
    const result = await mail.send(note, { body: 'x' }, { to: 'ada@example.com' });
    expect(result).toMatchObject({ id: 'm1' });
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('local and staging safety', () => {
  it('logTransport sends nothing and says so', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await mailer({ transport: logTransport(), from: 'hi@app.dev' }).send(
      note,
      { body: 'x' },
      { to: 'ada@example.com' },
    );
    expect(result).toMatchObject({ status: 'simulated', id: null, transport: 'log' });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('redirectTo sends every mail to the staging inbox only', async () => {
    const { transport, sent } = recording();
    const mail = mailer({ transport, from: 'hi@app.dev', redirectTo: 'staging@app.dev' });
    await orThrow(mail.send(note, { body: 'x' }, { to: 'customer@example.com', cc: 'boss@example.com' }));
    expect(sent[0]).toMatchObject({ to: 'staging@app.dev', headers: { 'X-Original-To': 'customer@example.com' } });
    expect(sent[0]?.cc).toBeUndefined();
  });
});

describe('quota on a single transport', () => {
  it('a lone transport with a quota stops at it, like one inside failover', async () => {
    const { transport, send } = recording('resend', 1);
    const mail = mailer({ transport, from: 'hi@app.dev' });
    await expect(mail.send(note, { body: 'x' }, { to: 'a@b.c' })).resolves.toMatchObject({ id: 'm1' });
    expect(MailQuotaExhausted.is(await mail.send(note, { body: 'x' }, { to: 'a@b.c' }))).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
