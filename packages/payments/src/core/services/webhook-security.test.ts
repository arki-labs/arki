/**
 * The old webhook path's own Stripe signature check
 *
 * `WebhookSecurityService` verifies Stripe's `Stripe-Signature` header by hand. These tests sign
 * with Stripe's own `generateTestHeaderString`, so they check the hand-written HMAC against the
 * real thing: a delivery Stripe would sign passes, and a forged, tampered, stale, or replayed one
 * does not. PayPal and Square are not verified at all, so they must fail closed.
 */
import { createHmac } from 'node:crypto';

import Stripe from 'stripe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WebhookSecurityService } from './webhook-security.js';

const ALLOWED_IP = '203.0.113.10';
const SECRET = 'whsec_test_fake';
const EVENT_ID = 'evt_security_test';

// No network: only the test signer is used.
const stripe = new Stripe('sk_test_fake');

let service: WebhookSecurityService;

beforeEach(() => {
  // The constructor starts an hourly cleanup interval; keep it from outliving the test.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  service = new WebhookSecurityService({ allowedIps: [ALLOWED_IP], replayWindowSeconds: 300, maxRetries: 3 });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function eventPayload(type = 'customer.subscription.created') {
  return JSON.stringify({
    id: EVENT_ID,
    object: 'event',
    type,
    data: { object: { id: 'sub_security_test', object: 'subscription' } },
  });
}

function sign(payload: string, options: { secret?: string; timestamp?: number } = {}) {
  return stripe.webhooks.generateTestHeaderString({
    payload,
    secret: options.secret ?? SECRET,
    timestamp: options.timestamp ?? nowSeconds(),
  });
}

function validateStripe(payload: string, header: string, secret = SECRET, callerTimestamp = String(nowSeconds())) {
  return service.validateWebhook('stripe', payload, header, callerTimestamp, ALLOWED_IP, secret);
}

describe('WebhookSecurityService: Stripe signatures', () => {
  it('accepts a delivery Stripe signed, with our event name and the parsed body', async () => {
    const payload = eventPayload();

    const result = await validateStripe(payload, sign(payload));

    expect(result.isValid).toBe(true);
    expect(result.eventType).toBe('subscription.created');
    expect(result.data?.['id']).toBe(EVENT_ID);
  });

  it.each(['absent', 'rejected', 'malformed'])('fails closed when crypto is %s without marking the event processed', async (kind) => {
    const native = globalThis.crypto;
    const payload = eventPayload();
    const header = sign(payload);
    vi.stubGlobal('crypto', kind === 'absent' ? undefined : {
      subtle: {
        importKey: native.subtle.importKey.bind(native.subtle),
        verify: () => kind === 'rejected' ? Promise.reject(new Error('private provider credential')) : Promise.resolve('true'),
      },
    });
    const refused = await validateStripe(payload, header);
    expect(refused).toMatchObject({ isValid: false, error: 'Signature verification failed' });
    expect(JSON.stringify(refused)).not.toContain('private provider credential');
    vi.unstubAllGlobals();
    const recovered = await validateStripe(payload, header);
    expect(recovered.isValid).toBe(true);
  });

  it('rejects a delivery signed with another secret', async () => {
    const payload = eventPayload();

    const result = await validateStripe(payload, sign(payload, { secret: 'whsec_someone_else' }));

    expect(result.isValid).toBe(false);
  });

  it('rejects a body changed after signing', async () => {
    const header = sign(eventPayload());

    const result = await validateStripe(eventPayload('customer.subscription.deleted'), header);

    expect(result.isValid).toBe(false);
  });

  it('rejects everything when the secret is empty, because an empty-key HMAC is forgeable by anyone', async () => {
    // Apps pass `env.STRIPE_WEBHOOK_SECRET ?? ''`, so an unset env var arrives here as ''.
    const payload = eventPayload();
    const signedTimestamp = nowSeconds();
    const forged = `t=${signedTimestamp},v1=${createHmac('sha256', '').update(`${signedTimestamp}.${payload}`).digest('hex')}`;

    const result = await validateStripe(payload, forged, '');

    expect(result).toMatchObject({ isValid: false, error: 'Webhook secret is not configured' });
  });

  it('rejects a signature made 1000 seconds ago, even though the caller says it is fresh', async () => {
    const payload = eventPayload();

    const result = await validateStripe(payload, sign(payload, { timestamp: nowSeconds() - 1000 }));

    expect(result.isValid).toBe(false);
    expect(result.error).toContain('allowed window');
  });

  it('checks the timestamp Stripe signed, not the one the caller passes', async () => {
    const payload = eventPayload();

    const result = await validateStripe(payload, sign(payload), SECRET, '0');

    expect(result.isValid).toBe(true);
  });

  it('rejects a signed timestamp that is not a number', async () => {
    // Correctly signed, so only the timestamp parsing can reject it.
    const payload = eventPayload();
    const header = `t=abc,v1=${createHmac('sha256', SECRET).update(`abc.${payload}`).digest('hex')}`;

    const result = await validateStripe(payload, header);

    // A `t` that is not Unix seconds is a malformed header, not a time outside the window.
    expect(result).toMatchObject({ isValid: false, error: 'Invalid signature format' });
  });

  it('accepts when any v1 signature matches, as Stripe sends during a secret roll', async () => {
    const payload = eventPayload();
    const header = sign(payload).replace(',v1=', `,v1=${'0'.repeat(64)},v1=`);

    const result = await validateStripe(payload, header);

    expect(result.isValid).toBe(true);
  });

  it('rejects a v1 signature of the wrong length without throwing', async () => {
    const payload = eventPayload();

    const result = await validateStripe(payload, `t=${nowSeconds()},v1=abc`);

    expect(result).toMatchObject({ isValid: false, error: 'Signature verification failed' });
  });

  it('rejects a header that is not a Stripe signature', async () => {
    const result = await validateStripe(eventPayload(), 'garbage');

    expect(result).toMatchObject({ isValid: false, error: 'Invalid signature format' });
  });

  it('accepts a signed event we do not model, without an event name', async () => {
    const payload = eventPayload('charge.succeeded');

    const result = await validateStripe(payload, sign(payload));

    expect(result.isValid).toBe(true);
    expect(result.eventType).toBeUndefined();
  });

  it('rejects the same delivery the second time as a replay', async () => {
    const payload = eventPayload();
    const header = sign(payload);
    const callerTimestamp = String(nowSeconds());

    const first = await validateStripe(payload, header, SECRET, callerTimestamp);
    const second = await validateStripe(payload, header, SECRET, callerTimestamp);

    expect(first.isValid).toBe(true);
    expect(second.isValid).toBe(false);
    expect(second.error).toContain('replay');
  });

  it('rejects a delivery from an IP that is not allowed', async () => {
    const payload = eventPayload();

    const result = await service.validateWebhook(
      'stripe',
      payload,
      sign(payload),
      String(nowSeconds()),
      '198.51.100.7',
      SECRET,
    );

    expect(result.isValid).toBe(false);
    expect(result.error).toContain('unauthorized IP');
  });
});

describe('WebhookSecurityService: providers without verification', () => {
  it.each(['paypal', 'square'] as const)('%s fails closed: its signature check is not implemented', async (provider) => {
    const result = await service.validateWebhook(
      provider,
      eventPayload(),
      'any-signature',
      String(nowSeconds()),
      ALLOWED_IP,
      SECRET,
    );

    expect(result.isValid).toBe(false);
    expect(result.error).toContain('not implemented');
  });

  it('rejects a caller timestamp that is not a number instead of letting it through', async () => {
    const result = await service.validateWebhook('paypal', eventPayload(), 'any-signature', 'abc', ALLOWED_IP, SECRET);

    expect(result).toMatchObject({ isValid: false, error: 'Invalid timestamp format' });
  });
});
