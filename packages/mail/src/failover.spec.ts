/**
 * `failover` decides which provider sends a mail. Why these rules matter: a quota is money, a
 * second provider after a timeout sends the customer two password resets, and a bad address
 * retried on three providers burns three sender reputations.
 */
import { describe, expect, it, vi } from 'vitest';

import type { Result } from '@arki/failure';
import { isFailure, orThrow } from '@arki/failure';

import type { QuotaStore } from './quota-store.js';
import type { MailMessage, MailTransport, SentMail, TransportFailure } from './types.js';
import { MailError } from './errors.js';
import { failover } from './failover.js';
import { MailQuotaExhausted, MailRejected, MailUncertain } from './failures.js';
import { inMemoryQuotaStore } from './quota-store.js';

const message: MailMessage = { from: 'hi@app.dev', to: 'ada@example.com', subject: 'Hi', text: 'Hello' };
const now = (): Date => new Date('2026-10-16T12:00:00Z');

type Answer = Result<SentMail, TransportFailure>;

const accepted = (transport: string): Answer => ({
  id: `${transport}-1`,
  transport,
  status: 'accepted',
  recipients: [],
});
// 429-like: the provider surely did not take it, and a later try can pass.
const refused = (transport: string): Answer => MailRejected({ transport, retryable: true, upstreamStatus: 429 });
const timedOut = (transport: string): Answer => MailUncertain({ transport, detail: 'no answer from the service' });
const badAddress = (transport: string): Answer => MailRejected({ transport, retryable: false, upstreamStatus: 422 });

/** A transport that answers from a script and counts its calls. */
function scripted(id: string, answer: (id: string) => Answer, quotaPerMonth?: number) {
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
    expect(result).toMatchObject({ transport: 'ses' });
    expect(resend.send).not.toHaveBeenCalled();
  });

  it('counts accepted sends, so the quota fills up and the next month starts fresh', async () => {
    const store = inMemoryQuotaStore();
    const resend = scripted('resend', accepted, 2);
    const chain = failover([resend.transport], { store, now });
    await orThrow(chain.send(message, {}));
    await orThrow(chain.send(message, {}));
    expect(await store.getSent('resend', '2026-10')).toBe(2);
    expect(await store.getSent('resend', '2026-11')).toBe(0);
  });

  it('when every transport is over quota, sends nothing and returns MailQuotaExhausted', async () => {
    const store = inMemoryQuotaStore();
    await store.increment('resend', '2026-10');
    const resend = scripted('resend', accepted, 1);
    const result = await failover([resend.transport], { store, now }).send(message, {});
    expect(MailQuotaExhausted.is(result)).toBe(true);
    expect(result).toMatchObject({ data: { month: '2026-10' } });
    expect(resend.send).not.toHaveBeenCalled();
  });

  it('a failed send does not use up quota', async () => {
    const store = inMemoryQuotaStore();
    const resend = scripted('resend', badAddress, 5);
    expect(isFailure(await failover([resend.transport], { store, now }).send(message, {}))).toBe(true);
    expect(await store.getSent('resend', '2026-10')).toBe(0);
  });

  it('a counter that fails after the provider accepted does not turn the send into a failure', async () => {
    const store: QuotaStore = {
      getSent: () => Promise.resolve(0),
      increment: () => Promise.reject(new Error('kv down')),
    };
    const resend = scripted('resend', accepted, 5);
    const result = await failover([resend.transport], { store, now }).send(message, {});
    expect(result).toMatchObject({ id: 'resend-1' });
  });

  it('a counter that cannot be read does not stop the mail', async () => {
    const store: QuotaStore = {
      getSent: () => Promise.reject(new Error('kv down')),
      increment: () => Promise.resolve(),
    };
    const resend = scripted('resend', accepted, 5);
    await expect(failover([resend.transport], { store, now }).send(message, {})).resolves.toMatchObject({
      transport: 'resend',
    });
  });
});

describe('failover after a failed send', () => {
  it('a definite, retryable refusal moves on to the next transport', async () => {
    const resend = scripted('resend', refused);
    const ses = scripted('ses', accepted);
    const result = await failover([resend.transport, ses.transport], { now }).send(message, {});
    expect(result).toMatchObject({ transport: 'ses' });
  });

  it('after a timeout the provider may be sending it: no second provider, the failure is returned', async () => {
    const resend = scripted('resend', timedOut);
    const ses = scripted('ses', accepted);
    const result = await failover([resend.transport, ses.transport], { now }).send(message, {});
    expect(MailUncertain.is(result)).toBe(true);
    expect(ses.send).not.toHaveBeenCalled();
  });

  it('a permanent refusal stops the chain', async () => {
    const resend = scripted('resend', badAddress);
    const ses = scripted('ses', accepted);
    const result = await failover([resend.transport, ses.transport], { now }).send(message, {});
    expect(result).toMatchObject({ code: 'mail.rejected', data: { retryable: false } });
    expect(ses.send).not.toHaveBeenCalled();
  });

  it('when every transport refuses, the last refusal is returned so the caller can retry later', async () => {
    const result = await failover([scripted('a', refused).transport, scripted('b', refused).transport], {
      now,
    }).send(message, {});
    expect(result).toMatchObject({ code: 'mail.rejected', data: { retryable: true, transport: 'b' } });
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
