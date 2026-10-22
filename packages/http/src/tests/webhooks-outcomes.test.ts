/** A crypto fault must never authenticate a delivery or produce malformed signing headers. */
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import { ID_GENERATION_FAILURES, RandomSourceUnavailable } from '@arki/contracts';
import { isFailure, orThrow, UnexpectedDefect } from '@arki/failure';

import type { WEBHOOK_VERIFY_FAILURES } from '../webhooks.js';
import { routes } from '../bundle.js';
import { route } from '../contract.js';
import { buildEngine } from '../compiled.js';
import { RequestCancelled } from '../failures.js';
import { step } from '../middleware.js';
import {
  hmac,
  standardWebhooks,
  stripe,
  verifyWebhook,
  WEBHOOK_FAILURES,
  WEBHOOK_SIGN_FAILURES,
  WebhookBodyTooLarge,
  WebhookBodyUnreadable,
  WebhookCryptoUnavailable,
  WebhookMalformed,
  WebhookSignatureMismatch,
} from '../webhooks.js';

const native = globalThis.crypto;
const body = new TextEncoder().encode('payload');
const signature = createHmac('sha256', 'secret').update(body).digest('hex');
const message = () => ({ headers: new Headers({ 'x-signature': signature }), body });
const scheme = () => hmac({ secrets: ['secret'], header: 'x-signature' });
function provider(overrides: object) {
  const subtle = {
    importKey: native.subtle.importKey.bind(native.subtle),
    verify: native.subtle.verify.bind(native.subtle),
    sign: native.subtle.sign.bind(native.subtle),
    digest: native.subtle.digest.bind(native.subtle),
    ...overrides,
  };
  vi.stubGlobal('crypto', { subtle });
  return subtle;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('webhook crypto boundaries', () => {
  it.each([undefined, null, {}])('returns unavailable capability for %j', crypto => {
    vi.stubGlobal('crypto', crypto);
    return expect(scheme().verify(message())).resolves.toMatchObject({ code: WebhookCryptoUnavailable.code });
  });

  it.each(['importKey', 'verify', 'digest', 'sign'])('detects an absent %s method', async method => {
    provider({ [method]: undefined });
    const result = method === 'sign' ? await scheme().sign(body) : await scheme().verify(message());
    expect(WebhookCryptoUnavailable.is(result)).toBe(true);
  });

  it.each(['importKey', 'verify', 'digest', 'sign'])('supervises a rejected %s method privately', async method => {
    const cause = new Error('private webhook secret');
    provider({ [method]: () => Promise.reject(cause) });
    const result = method === 'sign' ? await scheme().sign(body) : await scheme().verify(message());
    expect(result).toMatchObject({ code: UnexpectedDefect.code, cause });
  });

  it('supervises a throwing crypto getter', async () => {
    vi.stubGlobal('crypto', {
      get subtle() {
        throw new Error('private provider');
      },
    });
    expect(UnexpectedDefect.is(await scheme().verify(message()))).toBe(true);
  });

  it.each([undefined, null, {}, 'true', 1])('never authenticates a malformed verify result %j', async result => {
    provider({ verify: () => Promise.resolve(result) });
    expect(UnexpectedDefect.is(await scheme().verify(message()))).toBe(true);
  });

  it('keeps a genuine false verification result as an authentication refusal', async () => {
    provider({ verify: () => Promise.resolve(false) });
    expect(WebhookSignatureMismatch.is(await scheme().verify(message()))).toBe(true);
  });

  it.each(['digest', 'sign'])('validates actual %s bytes, including shadowed and detached buffers', async method => {
    const shadowed = new ArrayBuffer(1);
    Object.defineProperty(shadowed, 'byteLength', { value: 32 });
    const detached = new ArrayBuffer(32);
    structuredClone(detached, { transfer: [detached] });
    for (const invalid of [{ byteLength: 32 }, new Uint8Array(32), new ArrayBuffer(1), shadowed, detached]) {
      provider({ [method]: () => Promise.resolve(invalid) });
      const result = method === 'sign' ? await scheme().sign(body) : await scheme().verify(message());
      expect(UnexpectedDefect.is(result)).toBe(true);
    }
  });

  it.each([undefined, null, {}, { type: 'secret' }])('refuses a malformed imported key %j', async result => {
    provider({ importKey: () => Promise.resolve(result) });
    expect(UnexpectedDefect.is(await scheme().sign(body))).toBe(true);
  });

  it('preserves the receiver of every crypto method', async () => {
    const receivers: object[] = [];
    const subtle = provider({
      importKey(this: object, ...args: Parameters<SubtleCrypto['importKey']>) {
        receivers.push(this);
        return native.subtle.importKey(...args);
      },
      verify(this: object, ...args: Parameters<SubtleCrypto['verify']>) {
        receivers.push(this);
        return native.subtle.verify(...args);
      },
      sign(this: object, ...args: Parameters<SubtleCrypto['sign']>) {
        receivers.push(this);
        return native.subtle.sign(...args);
      },
      digest(this: object, ...args: Parameters<SubtleCrypto['digest']>) {
        receivers.push(this);
        return native.subtle.digest(...args);
      },
    });
    const subject = scheme();
    expect(isFailure(await subject.sign(body))).toBe(false);
    expect(isFailure(await subject.verify(message()))).toBe(false);
    expect(receivers.length).toBeGreaterThanOrEqual(4);
    expect(receivers.every(receiver => receiver === subtle)).toBe(true);
  });

  it('shares concurrent key import and retries a failed import on a later operation', async () => {
    const cause = new Error('temporary provider defect');
    const importKey = vi.fn(native.subtle.importKey.bind(native.subtle)).mockRejectedValueOnce(cause);
    provider({ importKey });
    const subject = scheme();
    expect(UnexpectedDefect.is(await subject.sign(body))).toBe(true);
    const [first, second] = await Promise.all([subject.sign(body), subject.sign(body)]);
    expect(isFailure(first)).toBe(false);
    expect(isFailure(second)).toBe(false);
    expect(importKey).toHaveBeenCalledTimes(2);
  });

  it('does not require entropy when the protocol does not sign an event ID', async () => {
    provider({});
    expect(isFailure(await stripe({ secrets: ['secret'] }).sign(body))).toBe(false);
    expect(isFailure(await scheme().sign(body))).toBe(false);
    const standard = standardWebhooks({ secrets: ['c2VjcmV0'] });
    expect(RandomSourceUnavailable.is(await standard.sign(body))).toBe(true);
    expect(isFailure(await standard.sign(body, { id: 'external-event' }))).toBe(false);
  });

  it('supervises throwing user prefix callbacks for sign and verify', async () => {
    const cause = new Error('private callback');
    const subject = hmac({
      secrets: ['secret'],
      header: 'x-signature',
      bodyPrefix: () => {
        throw cause;
      },
    });
    expect(await subject.sign(body)).toMatchObject({ code: UnexpectedDefect.code, cause });
    expect(await subject.verify(message())).toMatchObject({ code: UnexpectedDefect.code, cause });
  });

  it.each([Number.NaN, Infinity, -1])('cannot disable timestamp checking with tolerance %s', async tolerance => {
    const subject = stripe({ secrets: ['secret'] });
    const headers = orThrow(await subject.sign(body, { timestamp: 1 }));
    expect(isFailure(await subject.verify({ headers, body }, { tolerance }))).toBe(true);
  });

  it('rejects an authenticated timestamp outside the safe integer range', async () => {
    const timestamp = '9007199254740992';
    const signature = createHmac('sha256', 'secret').update(`${timestamp}.payload`).digest('hex');
    expect(
      WebhookMalformed.is(
        await stripe({ secrets: ['secret'] }).verify({
          headers: new Headers({ 'stripe-signature': `t=${timestamp},v1=${signature}` }),
          body,
        }),
      ),
    ).toBe(true);
  });

  it('derives public unions from canonical definition tuples', () => {
    const subject = scheme();
    expectTypeOf<Extract<Awaited<ReturnType<typeof subject.sign>>, { readonly code: string }>>().toEqualTypeOf<
      ReturnType<(typeof WEBHOOK_SIGN_FAILURES)[number]>
    >();
    expectTypeOf<Extract<Awaited<ReturnType<typeof subject.verify>>, { readonly code: string }>>().toEqualTypeOf<
      ReturnType<(typeof WEBHOOK_VERIFY_FAILURES)[number]>
    >();
    const _verify = verifyWebhook({ scheme: subject });
    expectTypeOf<Extract<Awaited<ReturnType<typeof _verify>>, { readonly code: string }>>().toEqualTypeOf<
      ReturnType<(typeof WEBHOOK_FAILURES)[number]>
    >();
    const unprotected = route.post('/unprotected', { id: 'webhooks.unprotected' });
    const protectedRoutes = routes().use(step(_verify));
    // @ts-expect-error Every protected contract must admit the exact step failure union.
    protectedRoutes.bind(unprotected, () => { /* Type admission must reject this contract. */ });
    expect(WEBHOOK_SIGN_FAILURES).toEqual(expect.arrayContaining([...ID_GENERATION_FAILURES]));
  });
});

describe('webhook request ownership', () => {
  it.each(['clone', 'stream'])('returns unreadable on %s refusal', async kind => {
    const req = new Request('https://test/hook', { method: 'POST', body: 'payload' });
    const cause = new Error('private request');
    if (kind === 'clone')
      vi.spyOn(req, 'clone').mockImplementation(() => {
        throw cause;
      });
    else
      vi.spyOn(req, 'clone').mockReturnValue(
        new Request('https://test/hook', {
          method: 'POST',
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(cause);
            },
          }),
          duplex: 'half',
        }),
      );
    expect(await verifyWebhook({ scheme: scheme() })({ req })).toMatchObject({
      code: WebhookBodyUnreadable.code,
      cause,
    });
  });

  it('refuses oversized and cancelled bodies before verification', async () => {
    const subject = scheme();
    const verify = vi.spyOn(subject, 'verify');
    const req = new Request('https://test/hook', { method: 'POST', body: 'payload' });
    expect(WebhookBodyTooLarge.is(await verifyWebhook({ scheme: subject, maxBodyBytes: 1 })({ req }))).toBe(true);
    const abort = new AbortController();
    abort.abort();
    expect(
      RequestCancelled.is(
        await verifyWebhook({ scheme: subject })({ req: new Request(req, { signal: abort.signal }) }),
      ),
    ).toBe(true);
    expect(verify).not.toHaveBeenCalled();
  });

  it('rechecks cancellation after awaited verification', async () => {
    const abort = new AbortController();
    const subject = scheme();
    vi.spyOn(subject, 'verify').mockImplementation(() => {
      abort.abort();
      return Promise.resolve({ id: 'authenticated', timestamp: undefined, body });
    });
    expect(
      RequestCancelled.is(
        await verifyWebhook({ scheme: subject })({
          req: new Request('https://test/hook', { method: 'POST', body: 'payload', signal: abort.signal }),
        }),
      ),
    ).toBe(true);
  });

  it('preserves an admitted custom failure and supervises custom rejection', async () => {
    const subject = scheme();
    const refusal = WebhookSignatureMismatch({ cause: new Error('private refusal') });
    const verify = vi.spyOn(subject, 'verify').mockResolvedValue(refusal);
    const verifyStep = verifyWebhook({ scheme: subject });
    expect(await verifyStep({ req: new Request('https://test/hook') })).toBe(refusal);
    const cause = new Error('private custom scheme');
    verify.mockRejectedValue(cause);
    expect(await verifyStep({ req: new Request('https://test/hook') })).toMatchObject({
      code: UnexpectedDefect.code,
      cause,
    });
  });

  it('declares step failures on the matched route and redacts private causes before the handler', async () => {
    const endpoint = route.post('/hook', { id: 'webhooks.outcomes', failures: WEBHOOK_FAILURES });
    const handler = vi.fn(() => {
      /* The refusal must prevent dispatch. */
    });
    const subject = scheme();
    vi.spyOn(subject, 'verify').mockRejectedValue(new Error('private webhook credential'));
    const engine = buildEngine([
      routes()
        .use(step(verifyWebhook({ scheme: subject })))
        .bind(endpoint, handler),
    ]);
    const response = await engine.fetch(
      new Request('https://test/hook', {
        method: 'POST',
        body: 'payload',
        headers: { 'x-request-id': 'explicit' },
      }),
    );
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toContain(UnexpectedDefect.code);
    expect(text).not.toContain('private webhook credential');
    expect(handler).not.toHaveBeenCalled();
  });
});
