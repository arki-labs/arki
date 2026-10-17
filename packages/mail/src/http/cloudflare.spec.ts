// Cloudflare answers per recipient and, in its older documented shape, without a message id.
// These tests keep two promises: an id is the service's own or null (never made up from a
// recipient address), and a bounce is never hidden behind a plain success.
import { describe, expect, it } from 'vitest';

import { orThrow } from '@arki/failure';

import type { MailMessage } from '../types.js';
import type { FetchFn } from './post-json.js';
import { MAIL_ERROR_CODES } from '../errors.js';
import { MailRejected, MailUncertain } from '../failures.js';
import { cloudflare } from './cloudflare.js';

const message: MailMessage = {
  from: 'Acme <digest@acme.dev>',
  to: ['a@example.com', 'b@example.com'],
  subject: 'Your digest',
  text: 'hi',
  html: '<p>hi</p>',
  replyTo: 'support@acme.dev',
  headers: { 'List-Unsubscribe': '<https://acme.dev/unsubscribe>' },
};

type Captured = { url: string; init: RequestInit | undefined };

/** A transport whose fake `fetch` answers once with `body` (a string is sent as-is). */
function answeredWith(status: number, body: unknown) {
  const calls: Captured[] = [];
  const fetch: FetchFn = (input, init) => {
    calls.push({ url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, init });
    return Promise.resolve(typeof body === 'string' ? new Response(body, { status }) : Response.json(body, { status }));
  };
  return { transport: cloudflare({ accountId: 'acct-123', apiToken: 'token-abc', fetch }), calls };
}

const envelope = (result: unknown) => ({ success: true, errors: [], messages: [], result });

describe('cloudflare request', () => {
  it('POSTs to the account endpoint with Bearer auth, one reply_to and the headers', async () => {
    const { transport, calls } = answeredWith(200, envelope({ delivered: ['a@example.com', 'b@example.com'] }));
    await orThrow(transport.send(message, {}));
    const call = calls[0];
    expect(call?.url).toBe('https://api.cloudflare.com/client/v4/accounts/acct-123/email/sending/send');
    expect(new Headers(call?.init?.headers).get('Authorization')).toBe('Bearer token-abc');
    const body = call?.init?.body;
    const sent: unknown = JSON.parse(typeof body === 'string' ? body : '');
    expect(sent).toMatchObject({
      to: ['a@example.com', 'b@example.com'],
      reply_to: 'support@acme.dev',
      headers: { 'List-Unsubscribe': '<https://acme.dev/unsubscribe>' },
    });
  });
});

describe('cloudflare response shapes', () => {
  it('API reference shape: id from message_id, suppressed recipients reported', async () => {
    const { transport } = answeredWith(
      200,
      envelope({
        message_id: 'cf-msg-1',
        delivered: ['a@example.com'],
        queued: [],
        permanent_bounces: [],
        suppressed_recipients: ['b@example.com'],
      }),
    );
    const data = orThrow(await transport.send(message, {}));
    expect(data).toEqual({
      id: 'cf-msg-1',
      transport: 'cloudflare',
      status: 'partial',
      recipients: [
        { address: 'a@example.com', status: 'accepted' },
        { address: 'b@example.com', status: 'suppressed' },
      ],
    });
  });

  it('REST guide shape (no message_id): id is null, queued counts as accepted', async () => {
    const { transport } = answeredWith(
      200,
      envelope({ delivered: ['a@example.com'], queued: ['b@example.com'], permanent_bounces: [] }),
    );
    const data = orThrow(await transport.send(message, {}));
    expect(data.id).toBeNull();
    expect(data.status).toBe('accepted');
    expect(data.recipients.every(recipient => recipient.status === 'accepted')).toBe(true);
  });

  it('a success with no per-recipient lists reports each recipient as unknown, not delivered', async () => {
    const { transport } = answeredWith(200, envelope({}));
    const data = orThrow(await transport.send(message, {}));
    expect(data.recipients).toEqual([
      { address: 'a@example.com', status: 'unknown' },
      { address: 'b@example.com', status: 'unknown' },
    ]);
  });
});

describe('cloudflare bounces', () => {
  it('some bounced: partial, with the bounced address marked rejected', async () => {
    const { transport } = answeredWith(
      200,
      envelope({ delivered: ['a@example.com'], queued: [], permanent_bounces: ['b@example.com'] }),
    );
    const data = orThrow(await transport.send(message, {}));
    expect(data.status).toBe('partial');
    expect(data.recipients).toContainEqual({ address: 'b@example.com', status: 'rejected' });
  });

  it('all bounced or suppressed: a MailRejected that is not retryable, so no transport tries it again', async () => {
    const { transport } = answeredWith(
      200,
      envelope({
        delivered: [],
        queued: [],
        permanent_bounces: ['a@example.com'],
        suppressed_recipients: ['b@example.com'],
      }),
    );
    const result = await transport.send(message, {});
    if (!MailRejected.is(result)) throw new Error('expected MailRejected');
    expect(result.data.retryable).toBe(false);
    expect(result.message).toContain('a@example.com');
  });
});

describe('cloudflare errors', () => {
  it('keeps the Cloudflare error code; a rate limit stays retryable', async () => {
    const { transport } = answeredWith(429, {
      success: false,
      errors: [{ code: 10_004, message: 'rate limited' }],
      messages: [],
      result: null,
    });
    const result = await transport.send(message, {});
    expect(MailRejected.is(result)).toBe(true);
    expect(result).toMatchObject({ data: { retryable: true, providerCode: '10004', upstreamStatus: 429 } });
  });

  it('a 2xx body that is not JSON: uncertain, because Cloudflare may have taken the mail', async () => {
    const { transport } = answeredWith(200, '<html>gateway</html>');
    const result = await transport.send(message, {});
    expect(MailUncertain.is(result)).toBe(true);
    expect(result).toMatchObject({ data: { upstreamStatus: 200 } });
  });

  it('a 2xx JSON body without a result: uncertain', async () => {
    const { transport } = answeredWith(200, { success: true });
    expect(MailUncertain.is(await transport.send(message, {}))).toBe(true);
  });

  it('tags are refused before any request', async () => {
    const { transport, calls } = answeredWith(200, envelope({}));
    await expect(transport.send({ ...message, tags: { kind: 'digest' } }, {})).rejects.toMatchObject({
      code: MAIL_ERROR_CODES.unsupported,
    });
    expect(calls).toHaveLength(0);
  });
});
