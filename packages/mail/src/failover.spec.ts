/**
 * `failover` decides which provider sends a mail. Why these rules matter: a quota is money, a
 * second provider after a timeout sends the customer two password resets, and a bad address
 * retried on three providers burns three sender reputations.
 */
import { describe, expect, it, vi } from 'vitest';

import type { QuotaStore } from './quota-store.js';
import type { MailFailure, MailMessage, MailResult, MailTransport } from './types.js';
import { MAIL_ERROR_CODES, MailError } from './errors.js';
import { failover } from './failover.js';
import { inMemoryQuotaStore } from './quota-store.js';

const message: MailMessage = { from: 'hi@app.dev', to: 'ada@example.com', subject: 'Hi', text: 'Hello' };
const now = (): Date => new Date('2026-10-16T12:00:00Z');

const accepted = (transport: string): MailResult => ({
  data: { id: `${transport}-1`, transport, status: 'accepted', recipients: [] },
  error: null,
});
const failure = (transport: string, extra: Partial<MailFailure>): MailResult => ({
  data: null,
  error: { code: MAIL_ERROR_CODES.rejected, message: 'no', retryable: true, acceptance: 'none', transport, ...extra },
});
const refused = (transport: string): MailResult => failure(transport, {}); // 429-like: definite and retryable
const timedOut = (transport: string): MailResult =>
  failure(transport, { code: MAIL_ERROR_CODES.uncertain, acceptance: 'unknown' });
const badAddress = (transport: string): MailResult => failure(transport, { retryable: false });

/** A transport that answers from a script and counts its calls. */
function scripted(id: string, answer: (id: string) => MailResult, quotaPerMonth?: number) {
  const send = vi.fn((_message: MailMessage) => Promise.resolve(answer(id)));
  const transport: MailTransport = { id, quotaPerMonth, send };
  return { transport, send };
}

describe('quota', () => {
  it('skips a transport over its quota for the month and sends through the next', async () => {
    const store = inMemoryQuotaStore();
    await store.increment('resend', '2026-10');
    const resend = scripted('resend', accepted, 1);
    const ses = scripted('ses', accepted);
    const result = await failover([resend.transport, ses.transport], { store, now }).send(message, {});
    expect(result.data?.transport).toBe('ses');
    expect(resend.send).not.toHaveBeenCalled();
  });

  it('counts accepted sends, so the quota fills up and the next month starts fresh', async () => {
    const store = inMemoryQuotaStore();
    const resend = scripted('resend', accepted, 2);
    const chain = failover([resend.transport], { store, now });
    await chain.send(message, {});
    await chain.send(message, {});
    expect(await store.getSent('resend', '2026-10')).toBe(2);
    expect(await store.getSent('resend', '2026-11')).toBe(0);
  });

  it('when every transport is over quota, sends nothing and returns E004', async () => {
    const store = inMemoryQuotaStore();
    await store.increment('resend', '2026-10');
    const resend = scripted('resend', accepted, 1);
    const result = await failover([resend.transport], { store, now }).send(message, {});
    expect(result.error).toMatchObject({ code: MAIL_ERROR_CODES.quotaExhausted, retryable: false });
    expect(resend.send).not.toHaveBeenCalled();
  });

  it('a failed send does not use up quota', async () => {
    const store = inMemoryQuotaStore();
    const resend = scripted('resend', badAddress, 5);
    await failover([resend.transport], { store, now }).send(message, {});
    expect(await store.getSent('resend', '2026-10')).toBe(0);
  });

  it('a counter that fails after the provider accepted does not turn the send into a failure', async () => {
    const store: QuotaStore = {
      getSent: () => Promise.resolve(0),
      increment: () => Promise.reject(new Error('kv down')),
    };
    const resend = scripted('resend', accepted, 5);
    const result = await failover([resend.transport], { store, now }).send(message, {});
    expect(result.data?.id).toBe('resend-1');
  });

  it('a counter that cannot be read does not stop the mail', async () => {
    const store: QuotaStore = {
      getSent: () => Promise.reject(new Error('kv down')),
      increment: () => Promise.resolve(),
    };
    const resend = scripted('resend', accepted, 5);
    await expect(failover([resend.transport], { store, now }).send(message, {})).resolves.toMatchObject({
      data: { transport: 'resend' },
    });
  });
});

describe('failover after a failed send', () => {
  it('a definite, retryable refusal moves on to the next transport', async () => {
    const resend = scripted('resend', refused);
    const ses = scripted('ses', accepted);
    const result = await failover([resend.transport, ses.transport], { now }).send(message, {});
    expect(result.data?.transport).toBe('ses');
  });

  it('after a timeout the provider may be sending it: no second provider, the failure is returned', async () => {
    const resend = scripted('resend', timedOut);
    const ses = scripted('ses', accepted);
    const result = await failover([resend.transport, ses.transport], { now }).send(message, {});
    expect(result.error).toMatchObject({ code: MAIL_ERROR_CODES.uncertain, acceptance: 'unknown' });
    expect(ses.send).not.toHaveBeenCalled();
  });

  it('a permanent refusal stops the chain', async () => {
    const resend = scripted('resend', badAddress);
    const ses = scripted('ses', accepted);
    const result = await failover([resend.transport, ses.transport], { now }).send(message, {});
    expect(result.error?.retryable).toBe(false);
    expect(ses.send).not.toHaveBeenCalled();
  });

  it('when every transport refuses, the last refusal is returned so the caller can retry later', async () => {
    const result = await failover([scripted('a', refused).transport, scripted('b', refused).transport], {
      now,
    }).send(message, {});
    expect(result.error).toMatchObject({ code: MAIL_ERROR_CODES.rejected, retryable: true, transport: 'b' });
  });
});

describe('configuration', () => {
  it('two transports with one id throw E001: their quotas would share a counter', () => {
    const one = scripted('resend', accepted).transport;
    expect(() => failover([one, one])).toThrow(MailError);
    expect(() => failover([one, one])).toThrow(/distinct `id`/);
    expect(() => failover([])).toThrow(/At least one transport/);
  });
});
