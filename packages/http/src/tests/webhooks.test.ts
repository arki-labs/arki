/**
 * Signed webhooks in. Why these tests matter: a route that trusts an unsigned or replayed webhook
 * lets anyone fake a payment or an event. So every check is shown failing on the one thing it
 * guards, and the signatures are checked against an outside reference (`node:crypto` and the
 * Standard Webhooks test vector), because a sign → verify round trip cannot catch a bug that both
 * directions share.
 */
import { createHash, createHmac } from 'node:crypto';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';

import type { WebhookScheme } from '../webhooks.js';
import { routes } from '../bundle.js';
import { route } from '../contract.js';
import { buildEngine } from '../engine.js';
import { HTTP_ERROR_CODES, HttpConfigError } from '../error.js';
import { hmac, standardWebhooks, stripe, verifyWebhook } from '../webhooks.js';

const encoder = new TextEncoder();
const bytes = (text: string): Uint8Array<ArrayBuffer> => encoder.encode(text);
const nowSeconds = (): number => Math.floor(Date.now() / 1000);
const hex = (secret: string, content: string): string => createHmac('sha256', secret).update(content).digest('hex');

afterEach(() => {
  vi.useRealTimers();
});

describe('standardWebhooks', () => {
  it('accepts the published Standard Webhooks test vector', async () => {
    vi.useFakeTimers({ now: 1_614_265_330_000 });
    const scheme = standardWebhooks({ secrets: ['whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'] });
    const headers = new Headers({
      'webhook-id': 'msg_p5jXN8AQM9LWM0D4loKWxJek',
      'webhook-timestamp': '1614265330',
      'webhook-signature': 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
    });
    await expect(scheme.verify({ headers, body: bytes('{"test": 2432232314}') })).resolves.toMatchObject({
      id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
      timestamp: 1_614_265_330,
    });
  });

  it('refuses a tampered body, a stale time and an unknown secret', async () => {
    const scheme = standardWebhooks({ secrets: ['whsec_c2VjcmV0LWtleS1vbmU='] });
    const headers = await scheme.sign('{"a":1}', { id: 'msg_1' });
    await expect(scheme.verify({ headers, body: bytes('{"a":1}') })).resolves.toMatchObject({ id: 'msg_1' });
    await expect(scheme.verify({ headers, body: bytes('{"a":2}') })).rejects.toMatchObject({
      status: 401,
      code: HTTP_ERROR_CODES.webhookSignatureMismatch,
    });

    const stale = await scheme.sign('{"a":1}', { id: 'msg_2', timestamp: nowSeconds() - 301 });
    await expect(scheme.verify({ headers: stale, body: bytes('{"a":1}') })).rejects.toMatchObject({
      code: HTTP_ERROR_CODES.webhookStale,
    });
    await expect(scheme.verify({ headers: stale, body: bytes('{"a":1}') }, { tolerance: 600 })).resolves.toMatchObject({
      id: 'msg_2',
    });

    const other = standardWebhooks({ secrets: ['whsec_b3RoZXItc2VjcmV0'] });
    await expect(other.verify({ headers, body: bytes('{"a":1}') })).rejects.toMatchObject({
      code: HTTP_ERROR_CODES.webhookSignatureMismatch,
    });
  });

  it('a signed time in the future is refused too: tolerance works both ways', async () => {
    const scheme = standardWebhooks({ secrets: ['whsec_c2VjcmV0LWtleS1vbmU='] });
    const headers = await scheme.sign('{}', { timestamp: nowSeconds() + 301 });
    await expect(scheme.verify({ headers, body: bytes('{}') })).rejects.toMatchObject({
      code: HTTP_ERROR_CODES.webhookStale,
    });
  });

  it('during a rotation, events signed with the old or the new secret both pass', async () => {
    const oldSecret = 'whsec_b2xkLXNlY3JldA==';
    const newSecret = 'whsec_bmV3LXNlY3JldA==';
    const receiver = standardWebhooks({ secrets: [newSecret, oldSecret] });
    for (const sender of [standardWebhooks({ secrets: [oldSecret] }), standardWebhooks({ secrets: [newSecret] })]) {
      const headers = await sender.sign('{}');
      await expect(receiver.verify({ headers, body: bytes('{}') })).resolves.toBeDefined();
    }
  });

  it('reads only v1 signatures and finds the matching one among several', async () => {
    const scheme = standardWebhooks({ secrets: ['whsec_c2VjcmV0LWtleS1vbmU='] });
    const signed = await scheme.sign('{}', { id: 'msg_3' });
    const good = signed.get('webhook-signature') ?? '';
    signed.set('webhook-signature', `v2,AAAA v1,bm90LWl0 ${good}`);
    await expect(scheme.verify({ headers: signed, body: bytes('{}') })).resolves.toMatchObject({ id: 'msg_3' });
  });

  it('missing headers are malformed, and a scheme without a usable secret fails when created', async () => {
    const scheme = standardWebhooks({ secrets: ['whsec_c2VjcmV0LWtleS1vbmU='] });
    await expect(scheme.verify({ headers: new Headers(), body: bytes('{}') })).rejects.toMatchObject({
      code: HTTP_ERROR_CODES.webhookMalformed,
    });
    expect(() => standardWebhooks({ secrets: [] })).toThrow(HttpConfigError);
    expect(() => standardWebhooks({ secrets: ['whsec_'] })).toThrow(HttpConfigError);
    expect(() => standardWebhooks({ secrets: ['whsec_%%%'] })).toThrow(HttpConfigError);
  });
});

describe('stripe', () => {
  const secret = 'whsec_stripe_test';
  const event = '{"id":"evt_1","type":"invoice.paid"}';

  it('accepts what Stripe signs (checked with node:crypto) and reads the event id from the body', async () => {
    const t = nowSeconds();
    const headers = new Headers({ 'stripe-signature': `t=${t},v1=${hex(secret, `${t}.${event}`)}` });
    await expect(stripe({ secrets: [secret] }).verify({ headers, body: bytes(event) })).resolves.toEqual({
      id: 'evt_1',
      timestamp: t,
      body: bytes(event),
    });
  });

  it('matches any v1 while Stripe rolls a secret, and refuses a tampered body or a stale t', async () => {
    const t = nowSeconds();
    const headers = new Headers({
      'stripe-signature': `t=${t},v1=${hex('whsec_old', `${t}.${event}`)},v1=${hex(secret, `${t}.${event}`)}`,
    });
    const scheme = stripe({ secrets: [secret] });
    await expect(scheme.verify({ headers, body: bytes(event) })).resolves.toMatchObject({ id: 'evt_1' });
    await expect(scheme.verify({ headers, body: bytes(`${event} `) })).rejects.toMatchObject({
      code: HTTP_ERROR_CODES.webhookSignatureMismatch,
    });

    const old = t - 301;
    const stale = new Headers({ 'stripe-signature': `t=${old},v1=${hex(secret, `${old}.${event}`)}` });
    await expect(scheme.verify({ headers: stale, body: bytes(event) })).rejects.toMatchObject({
      code: HTTP_ERROR_CODES.webhookStale,
    });
  });

  it('signs what node:crypto computes', async () => {
    const t = nowSeconds();
    const headers = await stripe({ secrets: [secret] }).sign(event, { timestamp: t });
    expect(headers.get('stripe-signature')).toBe(`t=${t},v1=${hex(secret, `${t}.${event}`)}`);
  });

  it('a header without t or without v1 is malformed; an empty secret fails when created', async () => {
    const scheme = stripe({ secrets: [secret] });
    for (const value of ['v1=abcd', `t=${nowSeconds()}`, 'garbage']) {
      await expect(
        scheme.verify({ headers: new Headers({ 'stripe-signature': value }), body: bytes(event) }),
      ).rejects.toMatchObject({ code: HTTP_ERROR_CODES.webhookMalformed });
    }
    expect(() => stripe({ secrets: [''] })).toThrow(HttpConfigError);
  });
});

describe('hmac', () => {
  it('GitHub: sha256=<hex> of the body alone; the id is the body hash, not the unsigned delivery header', async () => {
    const scheme = hmac({
      secrets: ['gh-secret'],
      header: 'x-hub-signature-256',
      headerPrefix: 'sha256=',
      idHeader: 'x-github-delivery',
    });
    const body = '{"action":"opened"}';
    const headers = new Headers({
      'x-hub-signature-256': `sha256=${hex('gh-secret', body)}`,
      'x-github-delivery': 'd-1',
    });
    const bodyHash = createHash('sha256').update(body).digest('hex');
    await expect(scheme.verify({ headers, body: bytes(body) })).resolves.toMatchObject({
      id: bodyHash,
      timestamp: undefined,
    });
    // A captured delivery resent under a new delivery id still has the same id, so the journal
    // key dedupes it. Were the id the header, this resend would run the event a second time.
    headers.set('x-github-delivery', 'd-forged');
    await expect(scheme.verify({ headers, body: bytes(body) })).resolves.toMatchObject({ id: bodyHash });
    headers.delete('x-github-delivery');
    await expect(scheme.verify({ headers, body: bytes(body) })).rejects.toMatchObject({
      code: HTTP_ERROR_CODES.webhookMalformed,
    });
  });

  it('Slack: a signed time in the prefix, so a replayed request goes stale', async () => {
    const scheme = hmac({
      secrets: ['slack-secret'],
      header: 'x-slack-signature',
      headerPrefix: 'v0=',
      timestampHeader: 'x-slack-request-timestamp',
      bodyPrefix: ({ timestamp }) => `v0:${timestamp}:`,
    });
    const body = 'token=x&team_id=T1';
    const t = nowSeconds();
    const headers = new Headers({
      'x-slack-signature': `v0=${hex('slack-secret', `v0:${t}:${body}`)}`,
      'x-slack-request-timestamp': String(t),
    });
    await expect(scheme.verify({ headers, body: bytes(body) })).resolves.toMatchObject({ timestamp: t });
    // Moving the time forward to dodge the tolerance breaks the signature, because the time is signed.
    headers.set('x-slack-request-timestamp', String(t + 1));
    await expect(scheme.verify({ headers, body: bytes(body) })).rejects.toMatchObject({
      code: HTTP_ERROR_CODES.webhookSignatureMismatch,
    });
  });

  it('base64 and SHA-512 round-trip through sign and verify', async () => {
    const scheme = hmac({ secrets: ['k'], header: 'x-sig', algorithm: 'SHA-512', encoding: 'base64' });
    const headers = await scheme.sign('payload');
    expect(headers.get('x-sig')).toBe(createHmac('sha512', 'k').update('payload').digest('base64'));
    await expect(scheme.verify({ headers, body: bytes('payload') })).resolves.toBeDefined();
  });
});

describe('the id type follows the scheme', () => {
  it('is a string where the scheme always carries one, so an inbox key needs no check', () => {
    expectTypeOf(standardWebhooks({ secrets: ['whsec_c2VjcmV0'] })).toEqualTypeOf<WebhookScheme<string>>();
    expectTypeOf(stripe({ secrets: ['s'] })).toEqualTypeOf<WebhookScheme>();
    expectTypeOf(hmac({ secrets: ['s'], header: 'x-sig' })).toEqualTypeOf<WebhookScheme<string>>();
  });
});

const post = (headers: Headers, body: string): Request => {
  headers.set('content-type', 'application/json');
  return new Request('http://test.local/hooks/orders', { method: 'POST', headers, body });
};

describe('verifyWebhook as a deriver', () => {
  const secret = 'whsec_c2VjcmV0LWtleS1vbmU=';
  const scheme = standardWebhooks({ secrets: [secret] });
  const orderEvent = route.post('/hooks/orders', {
    id: 'hooks.orders',
    body: z.object({ orderId: z.string() }),
    output: z.object({ id: z.string().optional(), orderId: z.string() }),
  });
  const envelope = z.object({ error: z.object({ code: z.string() }) });

  const serve = (maxBodyBytes?: number) => {
    const seen: string[] = [];
    const engine = buildEngine([
      routes()
        .derive('webhook', verifyWebhook({ scheme, ...(maxBodyBytes === undefined ? {} : { maxBodyBytes }) }))
        .bind(orderEvent, ({ body }, { webhook }) => {
          seen.push(body.orderId);
          return { id: webhook.id, orderId: body.orderId };
        }),
    ]);
    return { engine, seen };
  };

  it('a signed request reaches the handler, and the body schema parses the same bytes', async () => {
    const { engine, seen } = serve();
    const body = '{"orderId":"ord_1"}';
    const res = await engine.fetch(post(await scheme.sign(body, { id: 'msg_9' }), body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'msg_9', orderId: 'ord_1' });
    expect(seen).toEqual(['ord_1']);
  });

  it('a bad signature answers 401 and the handler never runs', async () => {
    const { engine, seen } = serve();
    const headers = await scheme.sign('{"orderId":"ord_1"}');
    const res = await engine.fetch(post(headers, '{"orderId":"ord_2"}'));
    expect(res.status).toBe(401);
    expect(envelope.parse(await res.json()).error.code).toBe(HTTP_ERROR_CODES.webhookSignatureMismatch);
    expect(seen).toEqual([]);
  });

  it('a body over maxBodyBytes answers 413 before any check', async () => {
    const { engine, seen } = serve(16);
    const body = JSON.stringify({ orderId: 'x'.repeat(64) });
    const res = await engine.fetch(post(await scheme.sign(body), body));
    expect(res.status).toBe(413);
    expect(envelope.parse(await res.json()).error.code).toBe(HTTP_ERROR_CODES.payloadTooLarge);
    expect(seen).toEqual([]);
  });
});
