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
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest';

import { isFailure, orThrow } from '@arki/failure';

import type { WebhookCheck } from './webhook-failures.js';
import { WebhookRejected } from './webhook-failures.js';
import { WebhookSecurityService } from './webhook-security.js';

const ALLOWED_IP = '203.0.113.10';
const SECRET = 'whsec_test_fake';
const EVENT_ID = 'evt_security_test';

// No network: only the test signer is used.
const stripe = new Stripe('sk_test_fake');

let service: WebhookSecurityService;

beforeEach(() => {
  service = orThrow(WebhookSecurityService.create({ allowedIps: [ALLOWED_IP], replayWindowSeconds: 300, maxRetries: 3 }));
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

/** The refusal `validateWebhook` returns: `payments.webhook_rejected`, naming the check that refused. */
function refusedBy(check: WebhookCheck, reason?: string) {
  return {
    code: 'payments.webhook_rejected',
    data: { check, retryable: false, ...(reason === undefined ? {} : { reason }) },
  };
}

describe('WebhookSecurityService: Stripe signatures', () => {
  it('accepts a delivery Stripe signed, with our event name and the parsed body', async () => {
    const payload = eventPayload();

    const result = await validateStripe(payload, sign(payload));

    assert(!isFailure(result));
    expect(result.eventType).toBe('subscription.created');
    expect(result.data['id']).toBe(EVENT_ID);
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
    expect(refused).toMatchObject(refusedBy('signature', 'Signature verification failed'));
    expect(JSON.stringify(refused)).not.toContain('private provider credential');
    vi.unstubAllGlobals();
    const recovered = await validateStripe(payload, header);
    expect(isFailure(recovered)).toBe(false);
  });

  it('rejects a delivery signed with another secret', async () => {
    const payload = eventPayload();

    const result = await validateStripe(payload, sign(payload, { secret: 'whsec_someone_else' }));

    expect(result).toMatchObject(refusedBy('signature'));
  });

  it('rejects a body changed after signing', async () => {
    const header = sign(eventPayload());

    const result = await validateStripe(eventPayload('customer.subscription.deleted'), header);

    expect(result).toMatchObject(refusedBy('signature'));
  });

  it('rejects everything when the secret is empty, because an empty-key HMAC is forgeable by anyone', async () => {
    // Apps pass `env.STRIPE_WEBHOOK_SECRET ?? ''`, so an unset env var arrives here as ''.
    const payload = eventPayload();
    const signedTimestamp = nowSeconds();
    const forged = `t=${signedTimestamp},v1=${createHmac('sha256', '').update(`${signedTimestamp}.${payload}`).digest('hex')}`;

    const result = await validateStripe(payload, forged, '');

    expect(result).toMatchObject(refusedBy('signature', 'Webhook secret is not configured'));
  });

  it('rejects a signature made 1000 seconds ago, even though the caller says it is fresh', async () => {
    const payload = eventPayload();

    const result = await validateStripe(payload, sign(payload, { timestamp: nowSeconds() - 1000 }));

    expect(result).toMatchObject(refusedBy('signature', 'Signature timestamp is outside the allowed window'));
  });

  it('checks the timestamp Stripe signed, not the one the caller passes', async () => {
    const payload = eventPayload();

    const result = await validateStripe(payload, sign(payload), SECRET, '0');

    expect(isFailure(result)).toBe(false);
  });

  it('rejects a signed timestamp that is not a number', async () => {
    // Correctly signed, so only the timestamp parsing can reject it.
    const payload = eventPayload();
    const header = `t=abc,v1=${createHmac('sha256', SECRET).update(`abc.${payload}`).digest('hex')}`;

    const result = await validateStripe(payload, header);

    // A `t` that is not Unix seconds is a malformed header, not a time outside the window.
    expect(result).toMatchObject(refusedBy('signature', 'Invalid signature format'));
  });

  it('accepts when any v1 signature matches, as Stripe sends during a secret roll', async () => {
    const payload = eventPayload();
    const header = sign(payload).replace(',v1=', `,v1=${'0'.repeat(64)},v1=`);

    const result = await validateStripe(payload, header);

    expect(isFailure(result)).toBe(false);
  });

  it('rejects a v1 signature of the wrong length without throwing', async () => {
    const payload = eventPayload();

    const result = await validateStripe(payload, `t=${nowSeconds()},v1=abc`);

    expect(result).toMatchObject(refusedBy('signature', 'Signature verification failed'));
  });

  it('rejects a header that is not a Stripe signature', async () => {
    const result = await validateStripe(eventPayload(), 'garbage');

    expect(result).toMatchObject(refusedBy('signature', 'Invalid signature format'));
  });

  it.each(['t=1\r\nX-Injected: 1', 't=1,v1=\uD800', 't=1,v1=\u00FF'])(
    'refuses a signature %j a header cannot carry as malformed, instead of throwing',
    async (header) => {
      const result = await validateStripe(eventPayload(), header);

      expect(result).toMatchObject(refusedBy('signature', 'Invalid signature format'));
    },
  );

  it('accepts a signed event we do not model, without an event name', async () => {
    const payload = eventPayload('charge.succeeded');

    const result = await validateStripe(payload, sign(payload));

    assert(!isFailure(result));
    expect(result.eventType).toBeUndefined();
  });

  it('rejects the same delivery the second time as a replay', async () => {
    const payload = eventPayload();
    const header = sign(payload);
    const callerTimestamp = String(nowSeconds());

    const first = await validateStripe(payload, header, SECRET, callerTimestamp);
    const second = await validateStripe(payload, header, SECRET, callerTimestamp);

    expect(isFailure(first)).toBe(false);
    expect(WebhookRejected.is(second)).toBe(true);
    expect(second).toMatchObject(refusedBy('replay'));
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

    expect(result).toMatchObject(refusedBy('source_ip', 'Webhook from unauthorized IP address: 198.51.100.7'));
  });
});

describe('WebhookSecurityService: allowedIps', () => {
  function deliverFrom(allowedIps: string[], sourceIp: string, provider: 'stripe' | 'razorpay' = 'razorpay') {
    const allowing = orThrow(WebhookSecurityService.create({ allowedIps, replayWindowSeconds: 300, maxRetries: 3 }));
    const payload = eventPayload();
    return allowing.validateWebhook(provider, payload, sign(payload), String(nowSeconds()), sourceIp, SECRET, {
      skipSignatureValidation: true,
    });
  }

  it.each([
    ['an address on the list', ['203.0.113.10'], '203.0.113.10'],
    ['an address inside an IPv4 range', ['10.20.0.0/16'], '10.20.255.1'],
    ['an address inside an IPv6 range', ['2001:db8::/32'], '2001:db8:1::7'],
    ['an IPv6 address on the list', ['2001:db8::1'], '2001:db8::1'],
    ['an IPv4 address written as IPv4-mapped IPv6', ['203.0.113.10'], '::ffff:203.0.113.10'],
  ])('lets %s through', async (_what, allowedIps, sourceIp) => {
    expect(isFailure(await deliverFrom(allowedIps, sourceIp))).toBe(false);
  });

  it.each([
    ['an address outside an IPv4 range', ['10.20.0.0/16'], '10.21.0.1'],
    ['an address outside an IPv6 range', ['2001:db8::/32'], '2001:db9::1'],
    ['text that is not an address', ['10.20.0.0/16'], 'not-an-ip'],
    ['an address with a leading zero', ['10.20.0.0/16'], '010.20.0.1'],
    ['an empty source', ['10.20.0.0/16'], ''],
  ])('refuses %s as source_ip', async (_what, allowedIps, sourceIp) => {
    expect(await deliverFrom(allowedIps, sourceIp)).toMatchObject(refusedBy('source_ip'));
  });

  it("lets Stripe's own addresses through without listing them", async () => {
    expect(isFailure(await deliverFrom([], '54.187.174.169', 'stripe'))).toBe(false);
  });

  it.each([
    ['a lone surrogate past the prefix limit', '\uD800/33'],
    ['a prefix past 32 bits', '10.0.0.0/33'],
    ['a prefix past 128 bits', '2001:db8::/129'],
    ['an empty prefix', '10.0.0.0/'],
    ['an octet past 255', '10.0.0.256'],
    ['a hostname', 'hooks.stripe.com'],
    ['an empty entry', ''],
  ])('refuses %s as payments.configuration_invalid when it is built, never letting an address through', (_what, entry) => {
    expect(WebhookSecurityService.create({ allowedIps: [entry], replayWindowSeconds: 300, maxRetries: 3 })).toMatchObject({
      code: 'payments.configuration_invalid',
    });
  });

  it('refuses more than MAX_BATCH_ITEMS entries as payments.configuration_invalid', () => {
    const allowedIps = Array.from({ length: 1001 }, () => ALLOWED_IP);

    expect(WebhookSecurityService.create({ allowedIps, replayWindowSeconds: 300, maxRetries: 3 })).toMatchObject({
      code: 'payments.configuration_invalid',
    });
  });
});

describe('WebhookSecurityService: replay set lifetime', () => {
  it('starts no timer, so a process that built one can still exit', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    orThrow(WebhookSecurityService.create({ allowedIps: [ALLOWED_IP], replayWindowSeconds: 300, maxRetries: 3 }));

    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('prunes deliveries older than twice the window during a later validation, at most hourly', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-30T10:00:00Z'));
    service = orThrow(WebhookSecurityService.create({ allowedIps: [ALLOWED_IP], replayWindowSeconds: 300, maxRetries: 3 }));

    const first = eventPayload('customer.subscription.created');
    expect(await validateStripe(first, sign(first))).toMatchObject({ provider: 'stripe' });
    expect(service.getProcessedEventCount()).toBe(1);

    // Two hours later the first delivery is past twice the window and the hourly cleanup is due.
    vi.setSystemTime(new Date('2026-10-30T12:00:00Z'));
    const second = eventPayload('customer.subscription.updated');
    expect(await validateStripe(second, sign(second))).toMatchObject({ provider: 'stripe' });
    expect(service.getProcessedEventCount()).toBe(1);
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

    expect(result).toMatchObject(refusedBy('signature'));
    expect(result).toMatchObject({ data: { reason: expect.stringContaining('not implemented') } });
  });

  it('rejects a caller timestamp that is not a number instead of letting it through', async () => {
    const result = await service.validateWebhook('paypal', eventPayload(), 'any-signature', 'abc', ALLOWED_IP, SECRET);

    expect(result).toMatchObject(refusedBy('timestamp', 'Invalid timestamp format'));
  });
});

describe('WebhookSecurityService: a window it cannot enforce is refused when it is built', () => {
  it.each([
    ['a NaN window, which would let every timestamp through', { replayWindowSeconds: Number.NaN }],
    ['a fractional window', { replayWindowSeconds: 1.5 }],
    ['no window at all', { replayWindowSeconds: 0 }],
    ['a window past one day', { replayWindowSeconds: 86_401 }],
    ['a negative retry count', { maxRetries: -1 }],
  ])('%s is payments.configuration_invalid', (_what, change) => {
    expect(
      WebhookSecurityService.create({ allowedIps: [ALLOWED_IP], replayWindowSeconds: 300, maxRetries: 3, ...change }),
    ).toMatchObject({ code: 'payments.configuration_invalid' });
  });
});

describe('WebhookSecurityService: the body is read through a JSON schema', () => {
  it('a signed body with a non-string type is valid but names no event', async () => {
    const payload = JSON.stringify({ id: EVENT_ID, object: 'event', type: 42, data: { object: {} } });

    const result = await validateStripe(payload, sign(payload));

    expect(result).toMatchObject({ provider: 'stripe', eventType: undefined, data: { type: 42 } });
  });

  it('a signed body that is not an object hands back empty data', async () => {
    const payload = '[1,2,3]';

    const result = await validateStripe(payload, sign(payload));

    assert(!isFailure(result));
    expect(result.data).toEqual({});
  });
});
